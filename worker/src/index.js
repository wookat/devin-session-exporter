const ALLOWED_ORIGIN = "https://app.devin.ai";
const DEVIN_ORIGIN = "https://app.devin.ai";
const DEFAULT_TTL_SECONDS = 86400;
const MAX_BODY_BYTES = 64 * 1024;
const SHARE_ID_BYTES = 16;
const IV_BYTES = 12;
const encoder = new TextEncoder();

const ATTACHMENT_MARKER_RE = /ATTACHMENT:(\{[^\n]*?\}|"[^"\n]*"|https?:\/\/\S+)/g;
const ATTACHMENT_URL_RE = /https?:\/\/[^\s"'<>()]+\/attachments\/[A-Za-z0-9-]+\/[^\s"'<>()]+/g;
const ATTACHMENT_PATH_RE = /\/attachments\/([A-Za-z0-9-]+\/[^\s"'<>()?#]+)/;
const TEXT_ATTACHMENT_EXT = /\.(?:md|markdown|txt|text|json|log|csv|tsv|ya?ml|diff|patch|xml|html?)(?:\?|$)/i;
const IMAGE_ATTACHMENT_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?|$)/i;
const MAX_INLINE_ATTACHMENT_BYTES = 100 * 1024;

function corsHeaders(origin) {
  if (origin !== ALLOWED_ORIGIN) return {};
  return {
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-methods": "POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin"
  };
}

function textResponse(body, status, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers
    }
  });
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(origin)
    }
  });
}

function isAllowedMutationOrigin(origin) {
  return !origin || origin === ALLOWED_ORIGIN;
}

function shareTtlSeconds(env) {
  const configured = Number(env.SHARE_TTL_SECONDS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TTL_SECONDS;
  return Math.max(60, Math.floor(configured));
}

function createShareId() {
  const bytes = new Uint8Array(SHARE_ID_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validShareId(id) {
  return /^[a-f0-9]{32}$/i.test(id);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(env) {
  if (!env.SHARE_KEY) throw new Error("SHARE_KEY is not configured");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(env.SHARE_KEY));
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptShare(payload, env) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    encoder.encode(JSON.stringify(payload))
  );
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
}

async function decryptShare(stored, env) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(stored.iv) },
    await encryptionKey(env),
    base64ToBytes(stored.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function normalizeDevinId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let id = raw;
  try {
    const url = new URL(raw);
    if (url.origin !== DEVIN_ORIGIN) return "";
    const match = url.pathname.match(/^\/sessions\/([^/]+)\/?$/);
    if (!match) return "";
    id = match[1];
  } catch {
    // Treat non-URL input as a bare session ID.
  }
  id = id.replace(/^devin-/i, "");
  return /^[A-Za-z0-9_-]+$/.test(id) ? `devin-${id}` : "";
}

async function createShare(request, env, origin) {
  if (!isAllowedMutationOrigin(origin)) {
    return textResponse("Origin not allowed", 403, corsHeaders(origin));
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "request too large" }, 413, origin);
  }
  let body;
  try {
    const raw = await request.text();
    if (encoder.encode(raw).byteLength > MAX_BODY_BYTES) {
      return jsonResponse({ error: "request too large" }, 413, origin);
    }
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "invalid JSON" }, 400, origin);
  }
  const devinId = normalizeDevinId(body?.devinId);
  if (!body || typeof body.token !== "string" || !body.token.trim()
      || typeof body.orgId !== "string" || !body.orgId.trim() || !devinId) {
    return jsonResponse({ error: "token, orgId, and devinId are required" }, 400, origin);
  }
  const ttl = shareTtlSeconds(env);
  let id = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = createShareId();
    if (!(await env.SHARES.get(candidate))) {
      id = candidate;
      break;
    }
  }
  if (!id) return jsonResponse({ error: "could not allocate share id" }, 503, origin);
  let encrypted;
  try {
    encrypted = await encryptShare({
      token: body.token,
      orgId: body.orgId,
      devinId
    }, env);
  } catch {
    return jsonResponse({ error: "share encryption is unavailable" }, 503, origin);
  }
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  await env.SHARES.put(id, JSON.stringify(encrypted), { expirationTtl: ttl });
  return jsonResponse({
    url: `${new URL(request.url).origin}/s/${id}`,
    id,
    expiresAt
  }, 201, origin);
}

function apiHeaders(token, orgId) {
  return {
    Authorization: `Bearer ${token}`,
    "x-cog-org-id": orgId,
    accept: "application/json"
  };
}

class ShareExpiredError extends Error {}

async function fetchDevinJson(path, token, orgId) {
  const response = await fetch(`${DEVIN_ORIGIN}${path}`, {
    headers: apiHeaders(token, orgId)
  });
  if (response.status === 401 || response.status === 403) {
    throw new ShareExpiredError("Share expired: the Devin login token is no longer valid");
  }
  if (!response.ok) {
    throw new Error(`Devin request failed (HTTP ${response.status})`);
  }
  return response.json();
}

async function fetchSessionEvents(devinId, token, orgId) {
  const events = [];
  let cursor = "";
  for (let page = 0; page < 200; page += 1) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const response = await fetch(
      `${DEVIN_ORIGIN}/api/events/${encodeURIComponent(devinId)}${query}`,
      { headers: apiHeaders(token, orgId) }
    );
    if (response.status === 401 || response.status === 403) {
      throw new ShareExpiredError("Share expired: the Devin login token is no longer valid");
    }
    if (!response.ok) {
      throw new Error(`Devin events request failed (HTTP ${response.status})`);
    }
    const payload = await response.json();
    const pageEvents = Array.isArray(payload.result) ? payload.result : [];
    events.push(...pageEvents);
    if (!payload.next_cursor || pageEvents.length === 0) break;
    cursor = payload.next_cursor;
  }
  return events;
}

function eventText(event) {
  const keys = event?.type === "user_question_answered"
    ? ["message", "answer", "answer_text", "response", "text"]
    : ["message", "text"];
  for (const key of keys) {
    if (typeof event?.[key] === "string" && event[key].trim()) return event[key].trim();
  }
  return "";
}

function parseAttachmentMarker(marker) {
  const payload = String(marker).slice("ATTACHMENT:".length).trim();
  if (payload.startsWith("{")) {
    try {
      const parsed = JSON.parse(payload);
      return { url: String(parsed.url || ""), fileSize: Number(parsed.fileSize) };
    } catch {
      return { url: "", fileSize: NaN };
    }
  }
  if (payload.startsWith("\"")) {
    try {
      return { url: String(JSON.parse(payload) || ""), fileSize: NaN };
    } catch {
      return { url: "", fileSize: NaN };
    }
  }
  return { url: payload, fileSize: NaN };
}

function attachmentName(url) {
  try {
    const last = String(url).split("/").pop().split("?")[0];
    return decodeURIComponent(last) || "attachment";
  } catch {
    return "attachment";
  }
}

function attachmentRelativePath(url) {
  const match = ATTACHMENT_PATH_RE.exec(String(url || ""));
  return match ? match[1] : "";
}

function proxiedAttachmentUrl(workerOrigin, shareId, relativePath) {
  const encoded = relativePath.split("/").map(encodeURIComponent).join("/");
  return `${workerOrigin}/a/${shareId}/${encoded}`;
}

async function fetchAttachmentCookie(token, orgId) {
  const response = await fetch(`${DEVIN_ORIGIN}/api/users/set-attachment-cookie`, {
    method: "POST",
    headers: { ...apiHeaders(token, orgId), "content-type": "application/json" },
    body: "{}"
  });
  if (!response.ok) return "";
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  for (const cookie of cookies) {
    const match = /attachments_token=([^;,\s]+)/.exec(cookie || "");
    if (match && match[1] && match[1] !== "\"\"" && match[1].length > 4) {
      return `attachments_token=${match[1]}`;
    }
  }
  return "";
}

// Fetches an attachment once with the share cookie. Returns the upstream status
// plus (optionally) the decoded text, so the renderer can distinguish
// "accessible" (200), "forbidden for this account" (401/403), and "other".
async function fetchAttachmentProbe(relativePath, cookie, wantText) {
  if (!cookie) return { status: 0, text: null };
  let response;
  try {
    response = await fetch(`${DEVIN_ORIGIN}/attachments/${relativePath}`, { headers: { cookie } });
  } catch {
    return { status: 0, text: null };
  }
  if (!response.ok || !wantText) {
    try { await response.body?.cancel?.(); } catch { /* ignore */ }
    return { status: response.status, text: null };
  }
  const raw = await response.text();
  const text = raw.length > MAX_INLINE_ATTACHMENT_BYTES
    ? `${raw.slice(0, MAX_INLINE_ATTACHMENT_BYTES)}\n…（已截断）`
    : raw;
  return { status: response.status, text };
}

// Rewrites attachment references so a reader without the owner account can still
// read them: text files are inlined, images/binaries become links proxied through
// this Worker (which re-authenticates upstream with the shared account token).
// Inlined text is itself rewritten (depth-bounded) so attachment markers embedded
// inside a handoff document are also converted instead of left as 401 URLs.
async function rewriteAttachments(value, ctx, depth = 0) {
  let text = String(value || "");
  if (!text) return text;
  const inlineText = depth < 1;
  const seen = new Map();
  const collect = (rawUrl, fileSize) => {
    const relativePath = attachmentRelativePath(rawUrl);
    if (!relativePath) return null;
    if (!seen.has(relativePath)) seen.set(relativePath, { rawUrl, fileSize });
    return relativePath;
  };
  const markers = text.match(ATTACHMENT_MARKER_RE) || [];
  const markerInfo = new Map();
  for (const marker of markers) {
    const { url, fileSize } = parseAttachmentMarker(marker);
    const relativePath = url ? collect(url, fileSize) : null;
    markerInfo.set(marker, relativePath);
  }
  const bareUrls = text.match(ATTACHMENT_URL_RE) || [];
  for (const url of bareUrls) collect(url, NaN);

  const cookie = await ctx.cookie();
  const replacements = new Map();
  for (const [relativePath, info] of seen) {
    const name = attachmentName(relativePath);
    const proxied = proxiedAttachmentUrl(ctx.workerOrigin, ctx.shareId, relativePath);
    const isImage = IMAGE_ATTACHMENT_EXT.test(name);
    const wantText = inlineText && TEXT_ATTACHMENT_EXT.test(name)
      && (!Number.isFinite(info.fileSize) || info.fileSize <= MAX_INLINE_ATTACHMENT_BYTES);
    const { status, text: body } = await fetchAttachmentProbe(relativePath, cookie, wantText);
    let rendered;
    if (status === 401 || status === 403) {
      // The sharing account itself has no access (e.g. the file was uploaded by
      // another account, common with pasted handoff docs) — no proxy can fix that.
      rendered = `（附件 ${name}：由其他账号上传，此分享账号无权读取）`;
    } else if (wantText && body != null) {
      rendered = `\n\n<附件 ${name}>\n${(await rewriteAttachments(body, ctx, depth + 1)).trim()}\n</附件 ${name}>\n`;
    } else if (isImage) {
      rendered = `![${name}](${proxied})`;
    } else {
      rendered = `[附件 ${name}](${proxied})`;
    }
    replacements.set(relativePath, rendered);
  }

  for (const [marker, relativePath] of markerInfo) {
    text = text.split(marker).join(relativePath ? replacements.get(relativePath) : "");
  }
  for (const url of bareUrls) {
    const relativePath = attachmentRelativePath(url);
    if (relativePath && replacements.has(relativePath)) {
      text = text.split(url).join(replacements.get(relativePath));
    }
  }
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function truncateOutput(value, maxLength = 400) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function formatTime(ms) {
  const time = Number(ms);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function firstLine(value, maxLength = 200) {
  const line = String(value || "").trim().split("\n").find((item) => item.trim());
  return truncateOutput(line || "", maxLength);
}

function sortedByTime(events) {
  return events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftTime = Number(left.event?.created_at_ms);
      const rightTime = Number(right.event?.created_at_ms);
      return (Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY)
        - (Number.isFinite(rightTime) ? rightTime : Number.POSITIVE_INFINITY)
        || left.index - right.index;
    })
    .map(({ event }) => event);
}

function renderWorklog(events) {
  const lines = [];
  const commandLines = new Map();
  for (const event of sortedByTime(events)) {
    switch (event?.type) {
      case "shell_process_started":
      case "shell_process_started_background": {
        if (typeof event.command !== "string" || !event.command.trim()) break;
        const entry = { text: `- $ ${event.command.trim()}`, output: "" };
        lines.push(entry);
        const startedAt = formatTime(event.created_at_ms);
        if (startedAt) entry.text = `- [${startedAt}] $ ${event.command.trim()}`;
        if (event.process_id != null) commandLines.set(String(event.process_id), entry);
        break;
      }
      case "shell_process_completed":
      case "shell_process_completed_background": {
        const entry = event.process_id == null ? null : commandLines.get(String(event.process_id));
        if (!entry || entry.completed) break;
        entry.completed = true;
        if (event.exit_code != null) entry.text += `  → 退出码 ${event.exit_code}`;
        const output = truncateOutput(event.output_trunc);
        if (output) entry.output = output;
        break;
      }
      case "multi_edit_result":
        for (const update of Array.isArray(event.file_updates) ? event.file_updates : []) {
          if (!update?.file_path) continue;
          lines.push({ text: `- ${update.action_type === "open" ? "读取" : "编辑"} ${update.file_path}` });
        }
        break;
      case "search_file_commands":
        for (const search of Array.isArray(event.search_commands) ? event.search_commands : []) {
          lines.push({ text: `- 搜索 ${search?.regex || ""} 于 ${search?.path || "unknown path"}` });
        }
        break;
      case "devin_thoughts":
        if (typeof event.message === "string" && event.message.trim()) {
          lines.push({ text: `- 思考：${truncateOutput(event.message, 600)}` });
        }
        break;
      case "status_update":
        if (typeof event.message === "string" && event.message.trim()) {
          lines.push({ text: `- 状态：${truncateOutput(event.message, 300)}` });
        }
        break;
      default:
        break;
    }
  }
  const rendered = [];
  for (const entry of lines) {
    if (entry.text.startsWith("- $ ") || /^- \[\d\d-\d\d \d\d:\d\d\] \$ /.test(entry.text)) {
      if (!entry.completed) entry.text += "  ⏳（未见完成事件，可能在此中断）";
    }
    rendered.push(entry.text);
    if (entry.output) {
      rendered.push("  ```", ...entry.output.split("\n").map((line) => `  ${line}`), "  ```");
    }
  }
  return rendered;
}

function renderPullRequests(metadata) {
  const pulls = Array.isArray(metadata?.pull_requests) ? metadata.pull_requests : [];
  return pulls
    .map((pull) => {
      const url = typeof pull?.url === "string" ? pull.url : (typeof pull?.pr_url === "string" ? pull.pr_url : "");
      if (!url) return "";
      const status = pull?.status || pull?.state || "";
      return `- ${url}${status ? ` (${status})` : ""}`;
    })
    .filter(Boolean);
}

function buildTldr(metadata, events, messages) {
  const lines = ["## TL;DR（AI 先读这里）", ""];
  const goal = messages.find((message) => message.role === "User");
  if (goal) {
    const attachments = (goal.text.match(ATTACHMENT_MARKER_RE) || [])
      .map((marker) => attachmentName(parseAttachmentMarker(marker).url))
      .filter(Boolean);
    const goalText = firstLine(goal.text.replace(ATTACHMENT_MARKER_RE, " "), 300)
      || (attachments.length ? `（首条消息为附件：${attachments.join("、")}）` : "");
    if (goalText) lines.push(`- **目标**：${goalText}`);
  }
  const status = String(metadata?.status_enum || metadata?.status || "").trim();
  if (status) lines.push(`- **会话状态**：${status}`);
  const latestTodos = sortedByTime(events).reverse()
    .find((event) => event?.type === "todo_update" && Array.isArray(event.todos) && event.todos.length);
  if (latestTodos) {
    const todos = latestTodos.todos;
    const done = todos.filter((todo) => todo?.status === "completed").length;
    lines.push(`- **TODO 进度**：${done}/${todos.length} 完成`);
    const next = todos.filter((todo) => todo?.status !== "completed").slice(0, 5);
    if (next.length) {
      lines.push("- **下一步**：");
      for (const todo of next) lines.push(`  - [ ] ${String(todo?.content || "").trim()}`);
    }
  }
  const interrupted = [];
  const running = new Map();
  for (const event of sortedByTime(events)) {
    if ((event?.type === "shell_process_started" || event?.type === "shell_process_started_background") && typeof event.command === "string" && event.command.trim()) {
      if (event.process_id != null) running.set(String(event.process_id), event);
    } else if ((event?.type === "shell_process_completed" || event?.type === "shell_process_completed_background") && event.process_id != null) {
      running.delete(String(event.process_id));
    }
  }
  for (const event of running.values()) interrupted.push(event);
  const lastInterrupted = interrupted[interrupted.length - 1];
  if (lastInterrupted) {
    lines.push(`- **中断点**：上个会话停在 \`$ ${firstLine(lastInterrupted.command, 200)}\`（已启动、未见完成事件）`);
  }
  const lastDevin = [...messages].reverse().find((message) => message.role === "Devin");
  if (lastDevin) {
    lines.push("- **最新进展（Devin 最后一条回复）**：", "");
    lines.push(`> ${truncateOutput(lastDevin.text, 800).split("\n").join("\n> ")}`);
  }
  lines.push("", "> 阅读指引：先看本段掌握目标/进度/下一步；「时间线（对话）」按时间顺序带时间戳；「Worklog」是逐条执行记录，带 ⏳ 的命令可能是中断点。续接时从「下一步」与「中断点」开始。", "");
  return lines;
}

async function renderMarkdown(metadata, events, attachmentCtx) {
  const title = String(metadata?.title || "Devin session").trim();
  const lines = [`# ${title}`, ""];
  const messages = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => ["initial_user_message", "user_message", "devin_message", "user_question_answered"].includes(event?.type))
    .map(({ event, index }) => ({
      index,
      createdAt: Number(event.created_at_ms),
      role: event.type === "devin_message" ? "Devin" : "User",
      text: eventText(event)
    }))
    .filter((message) => message.text)
    .sort((left, right) => (
      (Number.isFinite(left.createdAt) ? left.createdAt : Number.POSITIVE_INFINITY)
      - (Number.isFinite(right.createdAt) ? right.createdAt : Number.POSITIVE_INFINITY)
      || left.index - right.index
    ));
  lines.push(...buildTldr(metadata, events, messages));
  const pulls = renderPullRequests(metadata);
  if (pulls.length) {
    lines.push("## Pull Requests", "", ...pulls, "");
  }
  lines.push("## 时间线（对话）", "");
  for (const message of messages) {
    const text = attachmentCtx ? await rewriteAttachments(message.text, attachmentCtx) : message.text;
    const time = formatTime(message.createdAt);
    lines.push(`### ${time ? `[${time}] ` : ""}${message.role}`, "", text, "");
  }
  const latestTodos = sortedByTime(events).reverse()
    .find((event) => event?.type === "todo_update" && Array.isArray(event.todos) && event.todos.length);
  if (latestTodos) {
    lines.push("## Todos（最新状态）", "");
    for (const todo of latestTodos.todos) {
      lines.push(`- ${todo?.status === "completed" ? "[x]" : "[ ]"} ${String(todo?.content || "").trim()}`);
    }
    lines.push("");
  }
  const worklog = renderWorklog(events);
  if (worklog.length) {
    lines.push("## Worklog（执行详情）", "", ...worklog, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function loadShare(id, env) {
  if (!validShareId(id)) return null;
  const stored = await env.SHARES.get(id, "json");
  if (!stored?.iv || !stored?.ciphertext) return null;
  let share;
  try {
    share = await decryptShare(stored, env);
  } catch {
    return null;
  }
  if (!share?.token || !share?.orgId || !share?.devinId) return null;
  return share;
}

async function readShare(id, env, workerOrigin) {
  if (!validShareId(id)) return textResponse("Not found", 404);
  const stored = await env.SHARES.get(id, "json");
  if (!stored?.iv || !stored?.ciphertext) return textResponse("Not found", 404);
  const share = await loadShare(id, env);
  if (!share) return textResponse("Share expired or unavailable", 410);
  try {
    const metadata = await fetchDevinJson(
      `/api/sessions/${encodeURIComponent(share.devinId)}`,
      share.token,
      share.orgId
    );
    const events = await fetchSessionEvents(share.devinId, share.token, share.orgId);
    let cookiePromise;
    const attachmentCtx = {
      shareId: id,
      workerOrigin,
      cookie: () => {
        if (!cookiePromise) cookiePromise = fetchAttachmentCookie(share.token, share.orgId);
        return cookiePromise;
      }
    };
    const markdown = await renderMarkdown(metadata, events, attachmentCtx);
    return new Response(markdown, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    if (error instanceof ShareExpiredError) {
      return textResponse(error.message, 410);
    }
    return textResponse("Unable to read the live Devin session", 502);
  }
}

async function proxyAttachment(id, relativePath, env) {
  if (!validShareId(id)) return textResponse("Not found", 404);
  if (!/^[A-Za-z0-9-]+\/[^\s]+$/.test(relativePath) || relativePath.includes("..")) {
    return textResponse("Not found", 404);
  }
  const share = await loadShare(id, env);
  if (!share) return textResponse("Share expired or unavailable", 410);
  try {
    const cookie = await fetchAttachmentCookie(share.token, share.orgId);
    if (!cookie) return textResponse("Share expired: unable to authenticate attachment", 410);
    const upstream = await fetch(`${DEVIN_ORIGIN}/attachments/${relativePath}`, {
      headers: { cookie }
    });
    if (upstream.status === 401 || upstream.status === 403) {
      return textResponse("Attachment not accessible for this share", 403);
    }
    if (!upstream.ok) return textResponse("Attachment unavailable", 502);
    const headers = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    headers.set("cache-control", "private, max-age=300");
    headers.set("content-disposition", "inline");
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return textResponse("Attachment unavailable", 502);
  }
}

async function deleteShare(id, env, origin) {
  if (!isAllowedMutationOrigin(origin)) {
    return textResponse("Origin not allowed", 403, corsHeaders(origin));
  }
  if (!validShareId(id)) return textResponse("Not found", 404, corsHeaders(origin));
  await env.SHARES.delete(id);
  return jsonResponse({ ok: true }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      if (!isAllowedMutationOrigin(origin)) return textResponse("Origin not allowed", 403);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname === "/share" && request.method === "POST") {
      return createShare(request, env, origin);
    }
    const attachment = url.pathname.match(/^\/a\/([a-f0-9]{32})\/(.+)$/i);
    if (attachment && request.method === "GET") {
      return proxyAttachment(attachment[1], decodeURIComponent(attachment[2]), env);
    }
    const match = url.pathname.match(/^\/s\/([^/]+)$/);
    if (match && request.method === "GET") return readShare(match[1], env, url.origin);
    if (match && request.method === "DELETE") return deleteShare(match[1], env, origin);
    return textResponse("Not found", 404);
  }
};

export {
  renderMarkdown,
  parseAttachmentMarker,
  attachmentName,
  attachmentRelativePath,
  proxiedAttachmentUrl,
  rewriteAttachments
};
