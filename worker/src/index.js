const ALLOWED_ORIGIN = "https://app.devin.ai";
const DEVIN_ORIGIN = "https://app.devin.ai";
const DEFAULT_TTL_SECONDS = 86400;
const MAX_BODY_BYTES = 64 * 1024;
const SHARE_ID_BYTES = 16;
const IV_BYTES = 12;
const encoder = new TextEncoder();

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

function truncateOutput(value, maxLength = 400) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
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
        if (event.process_id != null) commandLines.set(String(event.process_id), entry);
        break;
      }
      case "shell_process_completed":
      case "shell_process_completed_background": {
        const entry = event.process_id == null ? null : commandLines.get(String(event.process_id));
        if (!entry) break;
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
      default:
        break;
    }
  }
  const rendered = [];
  for (const entry of lines) {
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

function renderMarkdown(metadata, events) {
  const title = String(metadata?.title || "Devin session").trim();
  const lines = [`# ${title}`, ""];
  const pulls = renderPullRequests(metadata);
  if (pulls.length) {
    lines.push("## Pull Requests", "", ...pulls, "");
  }
  lines.push("## Conversation", "");
  const messages = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => ["user_message", "devin_message", "user_question_answered"].includes(event?.type))
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
  for (const message of messages) {
    lines.push(`### ${message.role}`, "", message.text, "");
  }
  const worklog = renderWorklog(events);
  if (worklog.length) {
    lines.push("## Worklog（执行详情）", "", ...worklog, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function readShare(id, env) {
  if (!validShareId(id)) return textResponse("Not found", 404);
  const stored = await env.SHARES.get(id, "json");
  if (!stored?.iv || !stored?.ciphertext) return textResponse("Not found", 404);
  let share;
  try {
    share = await decryptShare(stored, env);
  } catch {
    return textResponse("Share expired or unavailable", 410);
  }
  if (!share?.token || !share?.orgId || !share?.devinId) {
    return textResponse("Share expired or unavailable", 410);
  }
  try {
    const metadata = await fetchDevinJson(
      `/api/sessions/${encodeURIComponent(share.devinId)}`,
      share.token,
      share.orgId
    );
    const events = await fetchSessionEvents(share.devinId, share.token, share.orgId);
    return new Response(renderMarkdown(metadata, events), {
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
    const match = url.pathname.match(/^\/s\/([^/]+)$/);
    if (match && request.method === "GET") return readShare(match[1], env);
    if (match && request.method === "DELETE") return deleteShare(match[1], env, origin);
    return textResponse("Not found", 404);
  }
};
