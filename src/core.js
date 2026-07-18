const MESSAGE_TYPES = new Set([
  "initial_user_message",
  "user_message",
  "devin_message",
  "devin_thoughts",
  "user_question_answered"
]);

function firstTextValue(event, fields) {
  for (const field of fields) {
    if (typeof event[field] === "string" && event[field].trim()) {
      return event[field];
    }
  }
  return "";
}

function buildMessages(events, options = {}) {
  const includeThoughts = options.includeThoughts === true;
  const includeQuestionAnswers = options.includeQuestionAnswers === true;

  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => {
      if (!MESSAGE_TYPES.has(event?.type)) {
        return false;
      }
      if (event.type === "devin_thoughts" && !includeThoughts) {
        return false;
      }
      if (event.type === "user_question_answered" && !includeQuestionAnswers) {
        return false;
      }
      return true;
    })
    .map(({ event, index }) => {
      const text = firstTextValue(event, event.type === "user_question_answered"
        ? ["message", "answer", "answer_text", "response", "text"]
        : ["message"]);

      return {
        index,
        role: event.type === "devin_message" || event.type === "devin_thoughts"
          ? "devin"
          : "user",
        type: event.type,
        text,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : null,
        createdAtMs: Number.isFinite(Number(event.created_at_ms))
          ? Number(event.created_at_ms)
          : Number.POSITIVE_INFINITY
      };
    })
    .filter((message) => message.text.trim())
    .sort((left, right) => left.createdAtMs - right.createdAtMs || left.index - right.index)
    .map(({ index, createdAtMs, ...message }) => message);
}

function eventTimestamp(event) {
  if (typeof event.timestamp === "string" && event.timestamp) {
    return event.timestamp;
  }
  if (Number.isFinite(Number(event.created_at_ms))) {
    return new Date(Number(event.created_at_ms)).toISOString();
  }
  return null;
}

function buildWorklog(events) {
  const sortedEvents = events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftTime = Number(left.event.created_at_ms);
      const rightTime = Number(right.event.created_at_ms);
      return (Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY)
        - (Number.isFinite(rightTime) ? rightTime : Number.POSITIVE_INFINITY)
        || left.index - right.index;
    });
  const worklog = [];
  const commandsByProcess = new Map();
  const pendingCompletions = new Map();

  const addCommand = (event, background) => {
    const command = {
      kind: "command",
      timestamp: eventTimestamp(event),
      command: typeof event.command === "string" ? event.command : "",
      shellId: event.shell_id ?? null,
      processId: event.process_id ?? null,
      startingDir: event.starting_dir ?? null,
      background,
      exitCode: null,
      output: null,
      isMajorAction: event.is_major_action === true
    };
    worklog.push(command);
    if (event.process_id != null) {
      commandsByProcess.set(String(event.process_id), command);
      const completion = pendingCompletions.get(String(event.process_id));
      if (completion) {
        Object.assign(command, completion);
        pendingCompletions.delete(String(event.process_id));
      }
    }
  };

  const addCompletion = (event, background) => {
    const processId = event.process_id == null ? null : String(event.process_id);
    const completion = {
      completedAt: eventTimestamp(event),
      exitCode: event.exit_code ?? null,
      output: typeof event.output_trunc === "string" ? event.output_trunc : null,
      background
    };
    const command = processId ? commandsByProcess.get(processId) : null;
    if (command) {
      Object.assign(command, completion);
    } else if (processId) {
      pendingCompletions.set(processId, completion);
    }
  };

  for (const { event } of sortedEvents) {
    switch (event.type) {
      case "devin_thoughts":
        if (typeof event.message === "string" && event.message.trim()) {
          worklog.push({
            kind: "thought",
            timestamp: eventTimestamp(event),
            text: event.message,
            thinkingDurationMs: event.thinking_duration_ms ?? null
          });
        }
        break;
      case "shell_process_started":
        addCommand(event, false);
        break;
      case "shell_process_started_background":
        addCommand(event, true);
        break;
      case "shell_process_completed":
        addCompletion(event, false);
        break;
      case "shell_process_completed_background":
        addCompletion(event, true);
        break;
      case "multi_edit_result":
        for (const update of Array.isArray(event.file_updates) ? event.file_updates : []) {
          const isRead = update.action_type === "open";
          worklog.push({
            kind: "file",
            timestamp: eventTimestamp(event),
            action: isRead ? "read" : (event.has_write || !isRead ? "edit" : "read"),
            path: update.file_path ?? null,
            startLine: update.start_line ?? null,
            endLine: update.end_line ?? null,
            totalLines: update.total_lines ?? null,
            contentsKey: update.contents_key ?? null,
            isMajorAction: event.is_major_action === true
          });
        }
        break;
      case "search_file_commands":
        for (const search of Array.isArray(event.search_commands) ? event.search_commands : []) {
          worklog.push({
            kind: "search",
            timestamp: eventTimestamp(event),
            path: search.path ?? null,
            regex: search.regex ?? null,
            commandName: search.command_name ?? null,
            resultFilenames: Array.isArray(event.search_result_filenames)
              ? event.search_result_filenames
              : [],
            isMajorAction: event.is_major_action === true
          });
        }
        break;
      case "todo_update":
        worklog.push({
          kind: "todos",
          timestamp: eventTimestamp(event),
          todos: Array.isArray(event.todos) ? event.todos : [],
          totalCount: event.total_count ?? null,
          completedCount: event.completed_count ?? null
        });
        break;
      case "status_update":
        if (typeof event.message === "string" && event.message.trim()) {
          worklog.push({
            kind: "status",
            timestamp: eventTimestamp(event),
            text: event.message
          });
        }
        break;
      default:
        break;
    }
  }

  return worklog;
}

function readAuthSession() {
  const rawAuth = localStorage.getItem("auth1_session");
  if (!rawAuth) {
    throw new Error("Not logged in to Devin (auth token not found)");
  }

  let authSession;
  try {
    authSession = JSON.parse(rawAuth);
  } catch {
    throw new Error("Not logged in to Devin (auth token not found)");
  }

  if (!authSession?.token || typeof authSession.token !== "string") {
    throw new Error("Not logged in to Devin (auth token not found)");
  }
  return authSession;
}

function collectOrgIds(authSession) {
  const orgIds = new Set();
  const addOrgId = (value) => {
    if (typeof value === "string" && /^org-[0-9a-f]{32}$/i.test(value)) {
      orgIds.add(value);
    }
  };

  addOrgId(authSession?.orgId);
  const userId = authSession.userId
    || authSession.uid
    || authSession.user_id
    || authSession.user?.uid
    || authSession.user?.id;
  if (userId) {
    try {
      const known = JSON.parse(localStorage.getItem(`known-org-ids-user-${userId}`) || "null");
      if (Array.isArray(known)) {
        known.forEach(addOrgId);
      }
    } catch {
      // Ignore malformed optional localStorage state.
    }
  }

  addOrgId(localStorage.getItem("last-internal-org-for-external-org-v1-null"));
  const orgPattern = /org-[0-9a-f]{32}/gi;
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index) || "";
    for (const match of key.matchAll(orgPattern)) {
      addOrgId(match[0]);
    }
  }
  return [...orgIds];
}

function apiHeaders(token, orgId) {
  return {
    Authorization: `Bearer ${token}`,
    "x-cog-org-id": orgId,
    accept: "application/json"
  };
}

async function resolveBillingOrg() {
  const authSession = readAuthSession();
  const orgIds = collectOrgIds(authSession);
  for (const orgId of orgIds) {
    try {
      const response = await fetch(`/api/${orgId}/billing/status`, {
        headers: apiHeaders(authSession.token, orgId)
      });
      if (response.ok) {
        return { orgId, token: authSession.token };
      }
    } catch {
      // Try the next known organization.
    }
  }
  throw new Error("找不到可访问的 Devin 计费组织");
}

async function fetchBillingInfo() {
  const context = await resolveBillingOrg();
  const headers = apiHeaders(context.token, context.orgId);
  const [statusResponse, limitsResponse] = await Promise.all([
    fetch(`/api/${context.orgId}/billing/status`, { headers }),
    fetch(`/api/${context.orgId}/billing/usage/limits`, { headers })
  ]);
  if (!statusResponse.ok || !limitsResponse.ok) {
    throw new Error("读取 Devin 计费信息失败");
  }
  const status = await statusResponse.json();
  const limits = await limitsResponse.json();
  return {
    orgId: context.orgId,
    availableCredits: status?.available_credits ?? null,
    overageCredits: status?.overage_credits ?? null,
    billingError: status?.billing_error ?? null,
    maxAcuLimit: limits?.max_acu_limit ?? null
  };
}

async function resolveAccountAuth(email, password) {
  const loginResponse = await fetch("/api/auth1/password/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    credentials: "omit",
    body: JSON.stringify({ email, password })
  });
  if (loginResponse.status === 401) {
    throw new Error("无法查询（可能非密码账号）");
  }
  if (!loginResponse.ok) {
    throw new Error(`账号登录查询失败（HTTP ${loginResponse.status}）`);
  }
  const login = await loginResponse.json();
  if (!login?.token) {
    throw new Error("账号登录查询未返回有效令牌");
  }
  const postAuthResponse = await fetch("/api/users/post-auth", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${login.token}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    credentials: "omit",
    body: "{}"
  });
  if (!postAuthResponse.ok) {
    throw new Error(`获取账号组织失败（HTTP ${postAuthResponse.status}）`);
  }
  const postAuth = await postAuthResponse.json();
  if (typeof postAuth?.org_id !== "string" || !postAuth.org_id) {
    throw new Error("获取账号组织失败（缺少组织 ID）");
  }
  return {
    email,
    token: login.token,
    userId: login.userId || login.uid || login.user_id || postAuth.user_id || postAuth.uid || null,
    orgId: postAuth.org_id,
    orgName: postAuth.org_name ?? null
  };
}

async function fetchBalanceForAuth(auth) {
  const headers = apiHeaders(auth.token, auth.orgId);
  const [statusResponse, limitsResponse] = await Promise.all([
    fetch(`/api/${auth.orgId}/billing/status`, { headers, credentials: "omit" }),
    fetch(`/api/${auth.orgId}/billing/usage/limits`, { headers, credentials: "omit" })
  ]);
  if (!statusResponse.ok) {
    throw new Error(`读取账号余额失败（HTTP ${statusResponse.status}）`);
  }
  if (!limitsResponse.ok) {
    throw new Error(`读取账号用量上限失败（HTTP ${limitsResponse.status}）`);
  }
  const status = await statusResponse.json();
  const limits = await limitsResponse.json();
  return {
    overageCredits: status?.overage_credits ?? null,
    availableCredits: status?.available_credits ?? null,
    maxAcuLimit: limits?.max_acu_limit ?? null,
    billingError: status?.billing_error ?? null,
    orgName: auth.orgName,
    orgId: auth.orgId || null,
    userId: auth.userId || null
  };
}

async function fetchBalanceForCredentials(email, password) {
  const auth = await resolveAccountAuth(email, password);
  return fetchBalanceForAuth(auth);
}

async function provisionAccount(email, password, targetLimit) {
  const auth = await resolveAccountAuth(email, password);
  if (Number.isFinite(targetLimit) && targetLimit >= 0) {
    try {
      await setUsageLimit(targetLimit, { orgId: auth.orgId, token: auth.token });
    } catch {
      // Balance query is still useful even if the limit update is rejected.
    }
  }
  return fetchBalanceForAuth(auth);
}

function normalizeSessionRecord(record) {
  const raw = record && typeof record === "object" ? record : {};
  let devinId = raw.devin_id || raw.session_id || raw.id || raw.devinId
    || raw.sessionId || raw.uuid || raw.conversation_id || raw.conversationId || raw.query_id || "";
  if (!devinId) {
    for (const key of ["url", "session_url", "web_url", "link"]) {
      const match = String(raw[key] || "").match(/\/sessions\/([A-Za-z0-9-]+)/);
      if (match) {
        devinId = `devin-${match[1].replace(/^devin-/, "")}`;
        break;
      }
    }
  }
  devinId = String(devinId || "");
  if (devinId && !devinId.startsWith("devin-")) devinId = `devin-${devinId}`;
  const sessionId = devinId.replace(/^devin-/, "");
  return {
    devinId,
    sessionId,
    title: raw.title || raw.name || raw.prompt || sessionId || "未命名",
    status: raw.status_enum || raw.status || raw.state || "",
    updatedAt: raw.updated_at || raw.last_updated_at || raw.updated || "",
    createdAt: raw.created_at || raw.created || ""
  };
}

function parseDevinSessionUrl(value) {
  const match = String(value || "").match(
    /https:\/\/app\.devin\.ai\/sessions\/([A-Za-z0-9_-]+)/i
  );
  return match ? match[1].replace(/^devin-/i, "") : "";
}

async function fetchSessionsForToken(token, orgId, limit = 200) {
  const headers = { ...apiHeaders(token, orgId) };
  const pickArray = (payload) => {
    for (const key of ["result", "sessions", "data"]) {
      if (Array.isArray(payload?.[key])) return payload[key];
    }
    return Array.isArray(payload) ? payload : [];
  };
  const primary = await fetch(
    `/api/${orgId}/v2sessions${limit ? `?limit=${limit}` : ""}`,
    { headers, credentials: "omit" }
  );
  if (primary.ok) {
    const payload = await primary.json();
    const list = pickArray(payload);
    if (list.length || payload?.result || payload?.sessions) {
      return list.map(normalizeSessionRecord).filter((session) => session.devinId);
    }
  }
  const fallback = await fetch("/api/sessions", { headers, credentials: "omit" });
  if (!fallback.ok) {
    throw new Error(`读取会话列表失败（HTTP ${fallback.status}）`);
  }
  return pickArray(await fallback.json()).map(normalizeSessionRecord).filter((session) => session.devinId);
}

async function fetchSessionsForCredentials(email, password) {
  const auth = await resolveAccountAuth(email, password);
  const sessions = await fetchSessionsForToken(auth.token, auth.orgId);
  return { auth, sessions };
}

async function exportListedSessionHandoff(session, auth, options = {}) {
  const events = await fetchAllEvents(session.devinId, auth.token, auth.orgId);
  const data = {
    sessionId: session.sessionId,
    url: `https://app.devin.ai/sessions/${session.sessionId}`,
    title: session.title,
    exportedAt: new Date().toISOString(),
    orgId: auth.orgId,
    messages: await inlineAttachments(buildMessages(events, {}), auth.token, auth.orgId),
    worklog: buildWorklog(events)
  };
  return buildHandoff(data, { includeFullConversation: options.includeFullConversation === true });
}

function buildVauthPayload(auth) {
  const payload = {
    token: auth.token,
    userId: auth.userId || null,
    orgId: auth.orgId,
    orgIds: auth.orgId ? [auth.orgId] : [],
    email: auth.email || null
  };
  const json = JSON.stringify(payload);
  const base64 = typeof btoa === "function"
    ? btoa(unescape(encodeURIComponent(json)))
    : Buffer.from(json, "utf8").toString("base64");
  return encodeURIComponent(base64);
}

function buildIsolatedSessionUrl(session, auth) {
  return `https://app.devin.ai/sessions/${session.sessionId}#daoauth=${buildVauthPayload(auth)}`;
}

function buildUsageLimitBody(dollars) {
  return { max_credits: dollars };
}

async function setUsageLimit(dollars, context) {
  const value = Number(dollars);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("消息用量上限必须是非负数字");
  }
  const billingContext = context || await resolveBillingOrg();
  const response = await fetch(
    `/api/${billingContext.orgId}/billing/usage/limits`,
    {
      method: "POST",
      headers: {
        ...apiHeaders(billingContext.token, billingContext.orgId),
        "content-type": "application/json"
      },
      body: JSON.stringify(buildUsageLimitBody(value))
    }
  );
  if (!response.ok) {
    throw new Error(`更新 Devin 消息用量上限失败（HTTP ${response.status}）`);
  }
  return response;
}

async function fetchSessionData(devinId, token, orgIds) {
  for (const orgId of orgIds) {
    const response = await fetch(`/api/sessions/${encodeURIComponent(devinId)}`, {
      headers: apiHeaders(token, orgId),
      credentials: "omit"
    });
    if (response.ok) {
      const metadata = await response.json();
      return {
        metadata,
        orgId: metadata.org_id || orgId
      };
    }
  }
  throw new Error("Could not resolve organization / session not accessible");
}

async function fetchAllEvents(devinId, token, orgId) {
  const events = [];
  let cursor = null;

  for (let page = 0; page < 200; page += 1) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const response = await fetch(`/api/events/${encodeURIComponent(devinId)}${query}`, {
      headers: apiHeaders(token, orgId),
      credentials: "omit"
    });
    if (!response.ok) {
      throw new Error(`Could not fetch Devin session events (HTTP ${response.status})`);
    }

    const payload = await response.json();
    const pageEvents = Array.isArray(payload.result) ? payload.result : [];
    events.push(...pageEvents);
    if (!payload.next_cursor || pageEvents.length === 0) {
      break;
    }
    cursor = payload.next_cursor;
  }
  return events;
}

async function fetchChanges(devinId, token, orgId) {
  const response = await fetch(
    `/api/ide/${encodeURIComponent(devinId)}/file_diffs`,
    { headers: apiHeaders(token, orgId) }
  );
  if (!response.ok) {
    throw new Error(`Could not fetch file changes (HTTP ${response.status})`);
  }
  return response.json();
}

async function extractConversation(options = {}) {
  const sessionMatch = window.location.pathname.match(/^\/sessions\/([^/]+)\/?$/);
  if (!sessionMatch) {
    throw new Error("Open a Devin session page first");
  }

  const authSession = readAuthSession();
  const sessionId = sessionMatch[1];
  const devinId = `devin-${sessionId}`;
  const { metadata, orgId } = await fetchSessionData(
    devinId,
    authSession.token,
    collectOrgIds(authSession)
  );
  const events = await fetchAllEvents(devinId, authSession.token, orgId);
  let changes = null;
  if (options.includeChanges) {
    try {
      changes = await fetchChanges(devinId, authSession.token, orgId);
    } catch (error) {
      changes = {
        error: error.message || "Changes unavailable"
      };
    }
  }

  return {
    sessionId,
    url: window.location.href,
    title: metadata.title || document.title || "Devin session",
    exportedAt: new Date().toISOString(),
    orgId,
    sections: {
      conversation: options.includeConversation !== false,
      worklog: options.includeWorklog === true,
      changes: options.includeChanges === true
    },
    messages: buildMessages(events, options),
    worklog: buildWorklog(events),
    changes
  };
}

const DEFAULT_HANDOFF_TEMPLATE = `你是接手这个项目的新会话。下面是上一个会话导出的交接上下文，请先完整阅读并理解，然后接着这个项目继续完成未完成的任务。若有不清楚的地方，先根据上下文自行判断，必要时再问我。

【上一会话的上下文】

{{HANDOFF}}
`;

// Kept as an example the user can drop into the prompt quick-clipboard; it is no
// longer forced into every continuation.
const SAMPLE_REMOTE_PROMPT = `你现在需要接入并使用我的远程 GPU 集群。当前阶段不要自行选择项目，也不要运行训练；先完成连接、了解集群使用方法，然后等待我提供具体任务。

【接入方式】
1. 检查 Tailscale：tailscale status
2. 如果没有安装：curl -fsSL https://tailscale.com/install.sh | sh
3. 需要 Tailscale auth key 时向我索取。不要把密钥保存到代码、脚本、日志或文档中。
4. 接入后连接主服务器：ssh dell@xu-1
5. 如果出现 Tailscale Check 授权链接，把完整链接发给我，等待我放行。

项目创建在 ~/wookat 下面，所有证据和材料都需要保存到 xu-1 服务器上，当前设备作为临时的，随时可能切换到新的设备新的会话继续完成任务。`;

const HANDOFF_COLLAPSE_PLACEHOLDER = "[续接自前序会话；完整历史见 xu-1 上的 ~/wookat 与 CONTINUATION.md]";

function handoffSafeText(value) {
  return String(value || "")
    .replace(/((?:api[_ -]?key|auth(?:entication)? key|token|password|secret)\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[private key redacted]");
}

function collapsePriorHandoff(value) {
  const text = String(value || "");
  const positions = [
    text.indexOf("【上一会话的上下文（用于续接）】"),
    text.indexOf("# Devin Context Handoff")
  ].filter((position) => position >= 0);
  if (!positions.length) return text;
  const prefix = text.slice(0, Math.min(...positions)).trimEnd();
  return prefix ? `${prefix}\n${HANDOFF_COLLAPSE_PLACEHOLDER}` : HANDOFF_COLLAPSE_PLACEHOLDER;
}

const ATTACHMENT_MARKER_RE = /ATTACHMENT:(\{[^\n]*?\}|"[^"\n]*"|https?:\/\/\S+)/g;
const TEXT_ATTACHMENT_EXT = /\.(?:md|markdown|txt|text|json|log|csv|tsv|ya?ml|diff|patch|xml|html?)(?:\?|$)/i;
const MAX_INLINE_ATTACHMENT_BYTES = 100 * 1024;
const CLUSTER_SIGNATURE = /tailscale/i;
const CLUSTER_SIGNATURE_2 = /\bsgpu\b/i;
const CLUSTER_COLLAPSE_PLACEHOLDER = "[集群接入说明：与前述模板相同，已折叠。见续接模板 / xu-1]";

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

function attachmentNote(url, fileSize) {
  const name = attachmentName(url);
  const size = Number.isFinite(fileSize) ? ` · ${Math.max(1, Math.round(fileSize / 1024))}KB` : "";
  return `[附件已省略：${name}${size}]`;
}

function summarizeAttachmentMarkers(value) {
  return String(value || "")
    .replace(ATTACHMENT_MARKER_RE, (marker) => {
      const { url, fileSize } = parseAttachmentMarker(marker);
      return url ? attachmentNote(url, fileSize) : "";
    })
    .replace(/\n{3,}/g, "\n\n");
}

async function fetchAttachmentText(url, token, orgId) {
  const attempts = [{ credentials: "include" }];
  if (token) attempts.push({ headers: apiHeaders(token, orgId), credentials: "omit" });
  for (const init of attempts) {
    try {
      const response = await fetch(url, init);
      if (!response.ok) continue;
      const text = await response.text();
      return text.length > MAX_INLINE_ATTACHMENT_BYTES
        ? `${text.slice(0, MAX_INLINE_ATTACHMENT_BYTES)}\n…（已截断）`
        : text;
    } catch {
      // Try the next auth strategy.
    }
  }
  return null;
}

async function inlineAttachmentsInText(value, token, orgId) {
  const text = String(value || "");
  const markers = text.match(ATTACHMENT_MARKER_RE);
  if (!markers) return text;
  let result = text;
  for (const marker of markers) {
    const { url, fileSize } = parseAttachmentMarker(marker);
    let replacement = "";
    if (url && TEXT_ATTACHMENT_EXT.test(url)
      && (!Number.isFinite(fileSize) || fileSize <= MAX_INLINE_ATTACHMENT_BYTES)) {
      const content = await fetchAttachmentText(url, token, orgId);
      const name = attachmentName(url);
      replacement = content != null
        ? `\n\n<附件 ${name}>\n${content.trim()}\n</附件 ${name}>\n`
        : `[附件（抓取失败）：${name}]`;
    } else if (url) {
      replacement = attachmentNote(url, fileSize);
    }
    result = result.replace(marker, replacement);
  }
  return result.replace(/\n{3,}/g, "\n\n");
}

async function inlineAttachments(messages, token, orgId) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    out.push({ ...message, text: await inlineAttachmentsInText(message.text, token, orgId) });
  }
  return out;
}

function collapseNoise(value, options = {}) {
  const maxLen = Number.isFinite(options.maxLen) ? options.maxLen : 1500;
  const seen = options.seen instanceof Set ? options.seen : null;
  let text = summarizeAttachmentMarkers(collapsePriorHandoff(value)).trim();
  if (seen && CLUSTER_SIGNATURE.test(text) && CLUSTER_SIGNATURE_2.test(text) && text.length > 400) {
    if (seen.has("cluster")) {
      return CLUSTER_COLLAPSE_PLACEHOLDER;
    }
    seen.add("cluster");
  }
  if (text.length > maxLen) {
    text = `${text.slice(0, maxLen).trimEnd()}\n…（已截断，完整历史见 xu-1）`;
  }
  return text;
}

function summarizeTodos(todos) {
  const list = Array.isArray(todos) ? todos : [];
  const done = list.filter((todo) => todo.status === "completed").length;
  const inProgress = list.filter((todo) => todo.status === "in_progress").length;
  const pending = list.filter((todo) => todo.status && todo.status !== "completed" && todo.status !== "in_progress").length;
  return { total: list.length, done, inProgress, pending };
}

function fileDateStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `_${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

function buildHandoff(data, options = {}) {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const worklog = Array.isArray(data.worklog) ? data.worklog : [];
  const seenBlocks = new Set();
  const users = messages
    .filter((message) => message.role === "user")
    .map((message) => ({ ...message, text: collapseNoise(message.text, { maxLen: 800, seen: seenBlocks }) }));
  const decisions = messages
    .filter((message) => message.role === "devin" && message.type === "devin_message")
    .map((message) => ({ ...message, text: collapseNoise(message.text, { maxLen: 1500 }) }));
  const latestTodos = [...worklog].reverse().find((entry) => entry.kind === "todos");
  const files = [...new Set(worklog
    .filter((entry) => entry.kind === "file" && entry.action !== "read" && entry.path)
    .map((entry) => entry.path)
    .filter((path) => !/(^|\/)(?:\.env|.*\.(?:pem|key))$|id_rsa/i.test(path)))];
  const environment = [];
  const majorActions = worklog.filter((entry) => entry.isMajorAction === true).slice(-12);

  for (const entry of worklog) {
    if (entry.kind !== "command") continue;
    const command = handoffSafeText(entry.command);
    const ssh = command.match(/\b(?:ssh|scp)\s+(?:-[^\s]+\s+)*(?:[\w.-]+@)?[\w.-]+/g) || [];
    const clones = command.match(/\bgit\s+clone\s+\S+/g) || [];
    const conda = command.match(/\bconda\s+(?:activate|create)\s+[^\s]+/g) || [];
    environment.push(...ssh.map((value) => `Remote target: ${value}`));
    environment.push(...clones.map((value) => `Repository: ${value}`));
    environment.push(...conda.map((value) => `Environment: ${value}`));
    if (entry.startingDir) environment.push(`Working directory: ${handoffSafeText(entry.startingDir)}`);
  }

  const majorText = majorActions.map((entry) => {
    if (entry.kind === "command") return `$ ${handoffSafeText(entry.command)}`;
    if (entry.kind === "file") return `${entry.action === "read" ? "Read" : "Edit"} ${entry.path || "unknown file"}`;
    if (entry.kind === "search") return `Search ${entry.regex || ""} in ${entry.path || "unknown path"}`;
    return handoffSafeText(entry.text || entry.kind);
  });
  const opKinds = new Set(["command", "file", "search"]);
  const formatOp = (entry) => {
    const time = entry.timestamp ? `[${entry.timestamp}] ` : "";
    if (entry.kind === "command") {
      const running = entry.completedAt == null && entry.exitCode == null;
      const tail = running
        ? "  ⏳（进行中/在此中断，尚未返回结果）"
        : (entry.exitCode != null ? `  → 退出码 ${entry.exitCode}` : "");
      return `${time}$ ${handoffSafeText(entry.command)}${tail}`;
    }
    if (entry.kind === "file") {
      return `${time}${entry.action === "read" ? "读取" : "编辑"} ${entry.path || "unknown file"}`;
    }
    return `${time}搜索 ${entry.regex || ""} 于 ${entry.path || "unknown path"}`;
  };
  const recentOps = worklog.filter((entry) => opKinds.has(entry.kind)).slice(-20);
  const runningOps = worklog.filter((entry) => (
    entry.kind === "command" && entry.completedAt == null && entry.exitCode == null && entry.command
  ));
  const todos = latestTodos && Array.isArray(latestTodos.todos) ? latestTodos.todos : [];
  const stats = summarizeTodos(todos);
  const nextSteps = todos.filter((todo) => todo.status !== "completed").slice(0, 5);
  const objective = users.length ? handoffSafeText(users[0].text).replace(/\s+/g, " ").slice(0, 240) : "";
  const lines = [
    "# Devin Context Handoff",
    "",
    `Source session: ${data.title || "Devin session"}`,
    `Source URL: ${data.url || ""}`,
    `Exported at: ${data.exportedAt || ""}`,
    "",
    "## TL;DR（先读这里）",
    `- 目标：${objective || "（未捕获用户消息）"}`,
    `- 进度：${stats.done}/${stats.total} 完成` + (stats.inProgress ? ` · 进行中 ${stats.inProgress}` : "") + (stats.pending ? ` · 待办 ${stats.pending}` : ""),
    "- 下一步：",
    ...(nextSteps.length
      ? nextSteps.map((todo) => `  - [ ] ${handoffSafeText(todo.content)}`)
      : ["  - （无未完成 TODO；见下方决策/最近动作）"]),
    "- 全量历史在 xu-1 的 ~/wookat 与 CONTINUATION.md；本文件只带最近增量。",
    "",
    "## Continuity",
    "Full cross-session history lives on xu-1 at ~/wookat and CONTINUATION.md.",
    "This handoff carries the latest session's decisions and progress as a recent delta.",
    "A new session should read xu-1 first, then use this handoff for current context.",
    "",
    "## Objective and evolution",
    ...(users.length ? users.map((message, index) => `${index + 1}. ${handoffSafeText(message.text)}`) : ["No user messages captured."]),
    "",
    "## Key decisions, conclusions, and current direction",
    ...(decisions.length ? decisions.map((message) => `- ${handoffSafeText(message.text)}`) : ["No Devin conclusions captured."]),
    "",
    "## Current status",
    ...(todos.length
      ? todos.map((todo) => `- ${todo.status === "completed" ? "[x]" : "[ ]"} ${handoffSafeText(todo.content)}`)
      : ["No todo state captured."]),
    "",
    "## Environment and how to resume",
    ...([...new Set(environment)].length ? [...new Set(environment)].map((item) => `- ${item}`) : ["Use the continuation template's cluster instructions."]),
    "",
    "## Files created or modified",
    ...(files.length ? files.map((file) => `- ${file}`) : ["No file edits captured."]),
    "",
    "## Recent major actions",
    ...(majorText.length ? majorText.map((item) => `- ${item}`) : ["No major actions captured."]),
    "",
    "## 最近操作步骤（含进行中）",
    ...(recentOps.length
      ? recentOps.map((entry) => `- ${formatOp(entry)}`)
      : ["No operations captured."]),
    "",
    "## 中断点（上个会话停在这一步）",
    ...(runningOps.length
      ? runningOps.map((entry) => `- ${formatOp(entry)}`)
      : ["- 无进行中的命令；上个会话应已跑完最后一步（见上方最近操作步骤）。"])
  ];
  if (options.includeFullConversation === true) {
    lines.push("", "## Full conversation", "The following messages are the complete captured conversation:", "");
    for (const message of messages) {
      lines.push(
        `### ${message.role === "user" ? "User" : "Devin"}`,
        collapseNoise(message.text, { maxLen: Number.POSITIVE_INFINITY }),
        ""
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function buildContinuationText(template, handoff) {
  const safeTemplate = typeof template === "string" ? template : DEFAULT_HANDOFF_TEMPLATE;
  if (!handoff) return safeTemplate;
  return safeTemplate.includes("{{HANDOFF}}")
    ? safeTemplate.replace(/\{\{HANDOFF\}\}/g, handoff)
    : `${safeTemplate.trimEnd()}\n\n---\n\n${handoff}`;
}

const applyHandoff = buildContinuationText;

function selectNextAccount(accounts, currentEmail, lastUsedEmail = "", options = {}) {
  const balances = options.balances instanceof Map ? options.balances : null;
  const minBalance = Number.isFinite(options.minBalance) ? options.minBalance : null;
  let ordered = Array.isArray(accounts) ? accounts.filter((account) => (
    account && typeof account.email === "string" && account.email.trim() && !account.archived
  )) : [];
  if (balances && minBalance != null) {
    ordered = ordered.filter((account) => {
      const info = balances.get(account.email.trim().toLowerCase());
      const balance = accountAvailableBalance(info || {});
      return Number.isFinite(balance) && balance > minBalance;
    });
  }
  if (!ordered.length) return null;
  const normalizedCurrent = String(currentEmail || "").trim().toLowerCase();
  const normalizedLast = String(lastUsedEmail || "").trim().toLowerCase();
  const index = ordered.findIndex((account) => account.email.trim().toLowerCase() === normalizedCurrent);
  const start = index >= 0
    ? index
    : ordered.findIndex((account) => account.email.trim().toLowerCase() === normalizedLast);
  const offset = start >= 0 ? 1 : 0;
  return ordered[(Math.max(start, 0) + offset) % ordered.length];
}

function routeAutoSwitch(currentUrl, state = {}, signals = {}) {
  const url = new URL(currentUrl, "https://app.devin.ai");
  const path = url.pathname;
  if (state.phase === "loggingOut") {
    return path === "/auth/login" ? "driveLogin" : (signals.loggedOut ? "navigateLogin" : "driveLogout");
  }
  if (state.phase === "loggingIn") {
    if (url.hostname === "devin.ai") return "navigateLogin";
    return path === "/auth/login" ? "driveLogin" : (path.startsWith("/org/") ? "createSession" : "wait");
  }
  if (state.phase === "creatingSession") {
    return path.startsWith("/org/") ? "createSession" : (path.startsWith("/sessions/") ? "done" : "wait");
  }
  if (state.phase === "idle" && signals.enabled && path.startsWith("/sessions/") && signals.quotaExceeded) {
    return "beginSwitch";
  }
  return "wait";
}

const extensionApi = globalThis.browser ?? globalThis.chrome;
const DEFAULT_TARGET_USAGE_LIMIT = 200;
const DEFAULT_SWITCH_MIN_BALANCE = 65;
const DEFAULT_SHARE_SERVICE_URL = "https://devin-session-share.wookat520.workers.dev";
const AUTO_SWITCH_KEYS = [
  "managedAccounts",
  "accountVault",
  "accountEncryptionEnabled",
  "autoSwitchEnabled",
  "autoSendContinuation",
  "autoSwitchState",
  "lastHandoff",
  "lastUsedAccountEmail",
  "continuationTemplate",
  "targetUsageLimit",
  "switchMinBalance"
];

function isExtensionContextValid() {
  try {
    return Boolean(extensionApi?.runtime?.id);
  } catch {
    return false;
  }
}

function storageGet(keys = AUTO_SWITCH_KEYS) {
  if (!isExtensionContextValid() || !extensionApi?.storage?.local) return Promise.resolve({});
  if (globalThis.browser) {
    try {
      return Promise.resolve(extensionApi.storage.local.get(keys)).catch((error) => {
        if (!isExtensionContextValid()) return {};
        throw error;
      });
    } catch (error) {
      return isExtensionContextValid() ? Promise.reject(error) : Promise.resolve({});
    }
  }
  return new Promise((resolve, reject) => {
    try {
      extensionApi.storage.local.get(keys, (result) => {
        if (!isExtensionContextValid()) {
          resolve({});
          return;
        }
        const error = extensionApi.runtime?.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result || {});
      });
    } catch (error) {
      if (isExtensionContextValid()) reject(error);
      else resolve({});
    }
  });
}

function storageSet(values) {
  if (!isExtensionContextValid() || !extensionApi?.storage?.local) return Promise.resolve();
  if (globalThis.browser) {
    try {
      return Promise.resolve(extensionApi.storage.local.set(values)).catch((error) => {
        if (!isExtensionContextValid()) return undefined;
        throw error;
      });
    } catch (error) {
      return isExtensionContextValid() ? Promise.reject(error) : Promise.resolve();
    }
  }
  return new Promise((resolve, reject) => {
    try {
      extensionApi.storage.local.set(values, () => {
        if (!isExtensionContextValid()) {
          resolve();
          return;
        }
        const error = extensionApi.runtime?.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    } catch (error) {
      if (isExtensionContextValid()) reject(error);
      else resolve();
    }
  });
}

function storageRemove(keys) {
  if (!isExtensionContextValid() || !extensionApi?.storage?.local) return Promise.resolve();
  if (globalThis.browser) {
    try {
      return Promise.resolve(extensionApi.storage.local.remove(keys)).catch((error) => {
        if (!isExtensionContextValid()) return undefined;
        throw error;
      });
    } catch (error) {
      return isExtensionContextValid() ? Promise.reject(error) : Promise.resolve();
    }
  }
  return new Promise((resolve, reject) => {
    try {
      extensionApi.storage.local.remove(keys, () => {
        if (!isExtensionContextValid()) {
          resolve();
          return;
        }
        const error = extensionApi.runtime?.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    } catch (error) {
      if (isExtensionContextValid()) reject(error);
      else resolve();
    }
  });
}

function bytesToBase64(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveAccountKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function cachedPassphrase() {
  try {
    return sessionStorage.getItem("devinExporterMasterPassphrase") || "";
  } catch {
    return "";
  }
}

function cachePassphrase(value) {
  try {
    if (value) sessionStorage.setItem("devinExporterMasterPassphrase", value);
    else sessionStorage.removeItem("devinExporterMasterPassphrase");
  } catch {
    // Session storage may be unavailable in a restricted page.
  }
}

async function encryptAccounts(accounts, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAccountKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(accounts))
  );
  return {
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
}

async function decryptAccounts(vault, passphrase) {
  const salt = base64ToBytes(vault.salt);
  const iv = base64ToBytes(vault.iv);
  const key = await deriveAccountKey(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    base64ToBytes(vault.ciphertext)
  );
  const accounts = JSON.parse(new TextDecoder().decode(plaintext));
  return Array.isArray(accounts) ? accounts : [];
}

async function loadManagedAccounts() {
  const stored = await storageGet(["managedAccounts", "accountVault", "accountEncryptionEnabled"]);
  if (!stored.accountEncryptionEnabled) {
    return Array.isArray(stored.managedAccounts) ? stored.managedAccounts : [];
  }
  if (!stored.accountVault) return [];
  let passphrase = cachedPassphrase();
  if (!passphrase) {
    passphrase = window.prompt("请输入账号列表主密码（仅本次浏览器会话缓存）") || "";
    if (!passphrase) throw new Error("需要主密码才能读取账号列表");
    cachePassphrase(passphrase);
  }
  try {
    return await decryptAccounts(stored.accountVault, passphrase);
  } catch {
    cachePassphrase("");
    throw new Error("账号列表解密失败，请检查主密码");
  }
}

async function saveManagedAccounts(accounts, encrypted, passphrase = "") {
  if (encrypted) {
    const effectivePassphrase = passphrase || cachedPassphrase()
      || window.prompt("设置账号列表主密码（仅本次浏览器会话缓存）")
      || "";
    if (!effectivePassphrase) throw new Error("未设置主密码，无法启用加密");
    cachePassphrase(effectivePassphrase);
    const accountVault = await encryptAccounts(accounts, effectivePassphrase);
    await storageSet({ accountVault, accountEncryptionEnabled: true });
    await storageRemove("managedAccounts");
    return;
  }
  cachePassphrase("");
  await storageSet({ managedAccounts: accounts, accountEncryptionEnabled: false });
  await storageRemove("accountVault");
}

function currentAccountEmail() {
  try {
    const session = JSON.parse(localStorage.getItem("auth1_session") || "null");
    return session?.email || session?.user?.email || session?.user_email || "";
  } catch {
    return "";
  }
}

function decodeBase64Url(segment) {
  const padded = String(segment).replace(/-/g, "+").replace(/_/g, "/");
  const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPad);
  try {
    return decodeURIComponent(binary.split("").map((c) => (
      `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`
    )).join(""));
  } catch {
    return binary;
  }
}

function jwtEmail(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return "";
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    return payload.email || payload.user_email || payload.preferred_username
      || payload.emailAddress || "";
  } catch {
    return "";
  }
}

function jwtUserId(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return "";
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    return String(payload.sub || payload.user_id || payload.uid || payload.userId
      || payload.user?.id || payload.user?.user_id || "");
  } catch {
    return "";
  }
}

function pickEmail(data) {
  if (!data || typeof data !== "object") return "";
  return data.email || data.user_email || data.emailAddress
    || data.user?.email || data.user?.user_email
    || data.account?.email || data.profile?.email || "";
}

function deepFindEmail(value, depth = 0) {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindEmail(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const field of ["email", "user_email", "emailAddress"]) {
      const direct = value[field];
      if (typeof direct === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(direct)) return direct;
    }
    for (const key of Object.keys(value)) {
      const found = deepFindEmail(value[key], depth + 1);
      if (found) return found;
    }
  }
  return "";
}

// Devin caches the signed-in user's profile in localStorage; scan it for an
// email so the current account shows even when no saved account matches.
function scanLocalStorageEmail() {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) || "";
      if (!/user|profile|auth|account|me\b/i.test(key)) continue;
      const raw = localStorage.getItem(key);
      if (!raw || !raw.includes("@")) continue;
      try {
        const found = deepFindEmail(JSON.parse(raw));
        if (found) return found;
      } catch {
        // Not JSON; skip.
      }
    }
  } catch {
    // localStorage may be unavailable.
  }
  return "";
}

function currentUserId(authSession) {
  return authSession?.userId || authSession?.uid || authSession?.user_id
    || authSession?.user?.uid || authSession?.user?.id || "";
}

// Match the currently logged-in org/user against saved accounts whose org/user
// we cached during a balance refresh. This works even when the account was
// switched outside our tool, as long as it is in the saved list.
function matchSavedAccountEmail(orgId, userId) {
  for (const account of accountDraft) {
    const info = accountBalanceCache.get(accountKey(account));
    if (!info) continue;
    if ((orgId && info.orgId === orgId) || (userId && info.userId === userId)) {
      if (account.email) return account.email;
    }
  }
  return "";
}

let currentEmailCache = "";
let currentEmailCacheToken = "";
async function resolveCurrentAccountEmail() {
  let authSession = null;
  try {
    authSession = readAuthSession();
  } catch {
    currentEmailCache = "";
    currentEmailCacheToken = "";
    return "";
  }
  if (authSession.token !== currentEmailCacheToken) {
    currentEmailCache = "";
    currentEmailCacheToken = authSession.token;
  }
  const tokenEmail = jwtEmail(authSession.token);
  if (tokenEmail) {
    currentEmailCache = tokenEmail;
    return tokenEmail;
  }
  const userId = jwtUserId(authSession.token) || currentUserId(authSession);
  let orgId = "";
  try {
    ({ orgId } = await resolveBillingOrg());
  } catch {
    orgId = "";
  }
  const matched = matchSavedAccountEmail(orgId, userId);
  if (matched) {
    currentEmailCache = matched;
    return matched;
  }
  const local = currentAccountEmail();
  if (local) {
    currentEmailCache = local;
    return local;
  }
  const headers = { Authorization: `Bearer ${authSession.token}`, accept: "application/json" };
  if (orgId) headers["x-cog-org-id"] = orgId;
  const endpoints = [];
  if (userId) endpoints.push(`/api/users/${userId}/profile`);
  endpoints.push("/api/users/current-membership");
  for (const url of endpoints) {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) continue;
      const email = pickEmail(await response.json());
      if (email) {
        currentEmailCache = email;
        return email;
      }
    } catch {
      // Try the next endpoint.
    }
  }
  try {
    const response = await fetch("/api/users/post-auth", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}"
    });
    if (response.ok) {
      const email = pickEmail(await response.json());
      if (email) {
        currentEmailCache = email;
        return email;
      }
    }
  } catch {
    // Fall through to localStorage scanning.
  }
  const cachedEmail = scanLocalStorageEmail();
  if (cachedEmail) {
    currentEmailCache = cachedEmail;
    return cachedEmail;
  }
  return currentEmailCache;
}

function isQuotaExceeded() {
  const text = document.body?.innerText || "";
  return /usage quota exceeded|usage quota has been exceeded|out of on-demand usage|ran out of free credits/i.test(text);
}

const QUOTA_CHECK_INTERVAL_MS = 5000;
let quotaCheckAt = 0;
let quotaExceededCache = false;

function isQuotaExceededThrottled() {
  const now = Date.now();
  if (now - quotaCheckAt < QUOTA_CHECK_INTERVAL_MS) return quotaExceededCache;
  quotaCheckAt = now;
  quotaExceededCache = isQuotaExceeded();
  return quotaExceededCache;
}

function findButtonContaining(text) {
  return [...document.querySelectorAll("button")].find((button) => {
    const style = getComputedStyle(button);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && (button.innerText || button.textContent || "").trim().toLowerCase().includes(text.toLowerCase());
  });
}

function advanceOnboarding() {
  const target = [...document.querySelectorAll("button")].find((button) => {
    const style = getComputedStyle(button);
    return !button.disabled
      && style.display !== "none"
      && style.visibility !== "hidden"
      && (button.innerText || button.textContent || "").trim().toLowerCase() === "continue";
  });
  if (!target) return false;
  target.click();
  return true;
}

function clickButtonContaining(text) {
  const target = findButtonContaining(text);
  if (!target) return false;
  target.click();
  return true;
}

function setNativeValue(element, value) {
  const prototype = element instanceof HTMLInputElement
    ? HTMLInputElement.prototype
    : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function findComposer() {
  const elements = [...document.querySelectorAll("textarea, div[contenteditable='true']")];
  return elements.find((element) => {
    const placeholder = element.getAttribute("placeholder")
      || element.querySelector("[contenteditable='false']")?.textContent
      || "";
    return /ask devin|build features|fix bugs|work on your code/i.test(placeholder);
  }) || elements.find((element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function injectComposerText(text) {
  const composer = findComposer();
  if (!composer) throw new Error("Could not find the Devin message composer");
  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    setNativeValue(composer, text);
    return composer;
  }

  let inserted = false;
  try {
    document.execCommand("selectAll", false);
    inserted = document.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }
  if (!inserted) {
    try {
      composer.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        data: text
      }));
      composer.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        clipboardData: new DataTransfer()
      }));
    } catch {
      // Fall through to the last-resort DOM update.
    }
  }
  if (!inserted) {
    composer.textContent = text;
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
  }
  return composer;
}

function clickSendButton() {
  const button = document.querySelector("button[aria-label='Send']");
  if (!button || button.disabled) return false;
  button.click();
  return true;
}

let toolbarStatusTimer = null;
function setToolbarStatus(message, isError = false) {
  statusMessage = message || "";
  statusIsError = isError === true;
  emit();
  if (toolbarStatusTimer) {
    clearTimeout(toolbarStatusTimer);
    toolbarStatusTimer = null;
  }
  // Keep errors visible; transient success/progress notices clear themselves so
  // the floating bar does not permanently display account chatter.
  if (message && !isError && typeof setTimeout === "function") {
    toolbarStatusTimer = setTimeout(() => {
      if (!statusIsError) {
        statusMessage = "";
        emit();
      }
    }, 4000);
  }
}

async function saveAutoSwitchState(state) {
  await storageSet({ autoSwitchState: state });
  currentPhase = state?.phase || "idle";
  emit();
}

function loginErrorVisible() {
  return /invalid password|incorrect password|unable to log in|login failed|wrong password/i
    .test(document.body?.innerText || "");
}

function accountAvailableBalance(info = {}) {
  // Devin's "Remaining balance" is billing_status.overage_credits (can be
  // negative once exhausted). available_credits is often 0 on pay-as-you-go
  // accounts, so it must not be treated as the balance.
  const overage = Number(info.overageCredits);
  if (Number.isFinite(overage)) return overage;
  const available = Number(info.availableCredits);
  return Number.isFinite(available) ? available : NaN;
}

function formatBalanceDisplay(info = {}) {
  const balance = accountAvailableBalance(info);
  const limit = Number(info.maxAcuLimit);
  const balanceText = Number.isFinite(balance) ? `$${balance.toFixed(2)}` : "—";
  const limitText = Number.isFinite(limit) ? `$${limit}` : "—";
  return `余额 ${balanceText} · 上限 ${limitText}`;
}

function formatBalanceOnly(info = {}) {
  const balance = accountAvailableBalance(info);
  return `余额 ${Number.isFinite(balance) ? `$${balance.toFixed(2)}` : "—"}`;
}

function balanceToneClass(info = {}) {
  if (/out_of_quota/i.test(info.billingError || "")) return "balance-negative";
  const balance = accountAvailableBalance(info);
  if (Number.isFinite(balance)) {
    return balance > DEFAULT_SWITCH_MIN_BALANCE ? "balance-positive" : "balance-negative";
  }
  return "balance-positive";
}

async function abortAutoSwitch(message) {
  await saveAutoSwitchState({
    phase: "failed",
    failedAt: new Date().toISOString(),
    message
  });
  setToolbarStatus(message, true);
}

async function waitForElement(getElement, timeout = 12000, interval = 300) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const element = getElement();
    if (element) return element;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return null;
}

async function driveLogout(state) {
  if (state.lastActionAt && Date.now() - state.lastActionAt < 1500) return;
  await saveAutoSwitchState({
    ...state,
    phase: "loggingIn",
    loginStep: "email",
    lastActionAt: Date.now(),
    stepStartedAt: Date.now(),
    attempts: (state.attempts || 0) + 1
  });
  setToolbarStatus("正在切换账号...");
  location.href = "https://app.devin.ai/logout";
}

async function driveLogin(state) {
  let accounts;
  try {
    accounts = await loadManagedAccounts();
  } catch (error) {
    await abortAutoSwitch(error.message);
    return;
  }
  const account = accounts.find((item) => item.email === state.targetEmail);
  if (!account || !account.email || !account.password) {
    await abortAutoSwitch("目标账号资料不完整，自动换号已停止");
    return;
  }
  if (loginErrorVisible()) {
    await abortAutoSwitch("登录失败，请检查账号密码");
    return;
  }
  const stepStartedAt = state.stepStartedAt || state.lastActionAt || Date.now();
  if (Date.now() - stepStartedAt > 15000) {
    await abortAutoSwitch("登录表单等待超时，自动换号已停止");
    return;
  }
  if (state.loginStep === "email") {
    const loginPair = await waitForElement(() => {
      const input = document.querySelector("input[type='email']");
      const button = findButtonContaining("log in");
      return input && button ? { input, button } : null;
    }, 900, 150);
    const emailInput = loginPair?.input || document.querySelector("input[type='email']");
    if (!emailInput) {
      setToolbarStatus("等待邮箱登录表单...");
      return;
    }
    setNativeValue(emailInput, account.email);
    const loginButton = await waitForElement(() => {
      const button = findButtonContaining("log in");
      return button && !button.disabled ? button : null;
    }, 900, 150);
    let submitted = false;
    if (loginButton) {
      loginButton.click();
      submitted = true;
    } else {
      if (findButtonContaining("log in")) {
        setToolbarStatus("等待登录按钮启用...");
      } else {
        try {
          const requestSubmit = emailInput.form?.requestSubmit;
          if (typeof requestSubmit === "function") {
            requestSubmit.call(emailInput.form);
            submitted = true;
          }
        } catch {
          submitted = false;
        }
      }
    }
    if (!submitted) {
      setToolbarStatus("等待登录按钮...");
      return;
    }
    await saveAutoSwitchState({
      ...state,
      loginStep: "password",
      lastActionAt: Date.now(),
      stepStartedAt: Date.now()
    });
    return;
  }
  if (state.loginStep === "password") {
    const loginPair = await waitForElement(() => {
      const input = document.querySelector("input[type='password']");
      const button = findButtonContaining("sign in");
      return input && button ? { input, button } : null;
    }, 900, 150);
    const passwordInput = loginPair?.input || document.querySelector("input[type='password']");
    if (!passwordInput) {
      setToolbarStatus("等待密码登录表单...");
      return;
    }
    setNativeValue(passwordInput, account.password);
    const signInButton = await waitForElement(() => {
      const button = findButtonContaining("sign in");
      return button && !button.disabled ? button : null;
    }, 900, 150);
    let submitted = false;
    if (signInButton) {
      signInButton.click();
      submitted = true;
    } else {
      if (findButtonContaining("sign in")) {
        setToolbarStatus("等待 Sign in 按钮启用...");
      } else {
        try {
          const requestSubmit = passwordInput.form?.requestSubmit;
          if (typeof requestSubmit === "function") {
            requestSubmit.call(passwordInput.form);
            submitted = true;
          }
        } catch {
          submitted = false;
        }
      }
    }
    if (!submitted) {
      setToolbarStatus("等待 Sign in 按钮...");
      return;
    }
    await saveAutoSwitchState({
      ...state,
      loginStep: "submitted",
      attempts: (state.attempts || 0) + 1,
      lastActionAt: Date.now()
    });
    return;
  }
  if (state.loginStep === "submitted"
      && state.lastActionAt
      && Date.now() - state.lastActionAt > 15000) {
    await abortAutoSwitch("登录超时，自动换号已停止");
  }
}

async function createContinuationSession(state) {
  if (state.lastActionAt && Date.now() - state.lastActionAt < 2000) return;
  const composer = findComposer();
  if (!composer) {
    const onboardingAttempts = (state.onboardingAttempts || 0) + 1;
    const onboardingStartedAt = state.onboardingStartedAt || Date.now();
    if (onboardingAttempts >= 40 || Date.now() - onboardingStartedAt >= 30000) {
      await abortAutoSwitch("新账号引导未自动完成，请手动点掉引导后重试");
      return;
    }
    advanceOnboarding();
    setTimeout(() => createContinuationSession({
      ...state,
      onboardingAttempts,
      onboardingStartedAt
    }).catch((error) => setToolbarStatus(error.message, true)), 800);
    return;
  }
  const stored = await storageGet([
    "continuationTemplate",
    "lastHandoff",
    "autoSendContinuation",
    "targetUsageLimit"
  ]);
  const targetUsageLimit = Number.isFinite(Number(stored.targetUsageLimit))
    ? Number(stored.targetUsageLimit)
    : DEFAULT_TARGET_USAGE_LIMIT;
  try {
    await setUsageLimit(targetUsageLimit);
    await refreshBalanceDisplay();
  } catch (error) {
    setToolbarStatus(`当前账号消息上限设置失败，继续续接：${error.message}`, true);
  }
  const text = buildContinuationText(
    stored.continuationTemplate || DEFAULT_HANDOFF_TEMPLATE,
    stored.lastHandoff?.text || ""
  );
  injectComposerText(text);
  const shouldSend = stored.autoSendContinuation !== false;
  if (shouldSend) {
    const sendButton = await waitForElement(() => {
      const button = document.querySelector("button[aria-label='Send']");
      return button && !button.disabled ? button : null;
    }, 5000);
    if (!sendButton || !clickSendButton()) {
      await abortAutoSwitch("续接内容已填入，但找不到可用的 Send 按钮");
      return;
    }
  }
  await storageSet({ lastUsedAccountEmail: state.targetEmail });
  await saveAutoSwitchState({
    ...state,
    phase: "done",
    completedAt: new Date().toISOString()
  });
  const switched = state.targetEmail ? `已切换到 ${state.targetEmail}` : "已切换账号";
  setToolbarStatus(shouldSend ? `${switched}，并已发送续接提示` : `${switched}，已填入续接提示`);
}

async function waitForComposerAfterOnboarding(timeout = 30000, interval = 800) {
  return waitForElement(() => {
    const composer = findComposer();
    if (!composer) advanceOnboarding();
    return composer;
  }, timeout, interval);
}

async function resolveLinkedSessionHandoff(sessionId) {
  const accounts = await loadManagedAccounts();
  const devinId = `devin-${sessionId}`;
  for (const account of accounts) {
    if (!account?.email || !String(account.password || "").trim()) continue;
    try {
      const auth = await resolveAccountAuth(account.email, account.password);
      const { metadata, orgId } = await fetchSessionData(
        devinId,
        auth.token,
        collectOrgIds(auth)
      );
      return await exportListedSessionHandoff(
        {
          devinId,
          sessionId,
          title: metadata.title || sessionId
        },
        { ...auth, orgId }
      );
    } catch {
      // Try the next saved account without exposing credentials or tokens.
    }
  }
  throw new Error("该会话所属账号未在本资料导入或无权限读取");
}

async function continueFromClipboard() {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    setToolbarStatus("无法读取剪贴板，请手动粘贴到输入框", true);
    return false;
  }
  if (!text.trim()) {
    setToolbarStatus("剪贴板为空，未执行续接", true);
    return false;
  }
  const linkedSessionId = parseDevinSessionUrl(text);
  if (linkedSessionId) {
    setToolbarStatus("正在读取会话链接…");
    try {
      const handoff = await resolveLinkedSessionHandoff(linkedSessionId);
      const stored = await storageGet(["continuationTemplate"]);
      text = buildContinuationText(
        stored.continuationTemplate || DEFAULT_HANDOFF_TEMPLATE,
        handoff
      );
    } catch (error) {
      setToolbarStatus(error.message || "读取会话链接失败", true);
      return false;
    }
  }
  setToolbarStatus("正在等待 Devin 输入框...");
  const composer = await waitForComposerAfterOnboarding();
  if (!composer) {
    setToolbarStatus("未找到 Devin 输入框，请手动打开首页后重试", true);
    return false;
  }
  try {
    injectComposerText(text);
    const sendButton = await waitForElement(() => {
      const button = document.querySelector("button[aria-label='Send']");
      return button && !button.disabled ? button : null;
    }, 5000);
    if (!sendButton || !clickSendButton()) {
      setToolbarStatus("续接内容已填入，但找不到可用的 Send 按钮", true);
      return false;
    }
    setToolbarStatus("已发送剪贴板续接内容");
    return true;
  } catch (error) {
    setToolbarStatus(error.message || "从剪贴板续接失败", true);
    return false;
  }
}

async function exportHandoffForSwitch(options = {}) {
  const data = await extractConversation({
    includeConversation: true,
    includeWorklog: true,
    includeChanges: true,
    includeThoughts: false
  });
  const token = (readAuthSession() || {}).token || null;
  data.messages = await inlineAttachments(data.messages, token, data.orgId);
  const compact = buildHandoff(data, { includeFullConversation: false });
  await storageSet({
    lastHandoff: {
      text: compact,
      exportedAt: new Date().toISOString(),
      title: data.title,
      url: data.url
    }
  });
  const full = options.includeFullConversation === true
    ? buildHandoff(data, { includeFullConversation: true })
    : null;
  return { data, compact, full };
}

async function beginAutoSwitch(manual = false) {
  const settings = await storageGet(["autoSwitchEnabled", "lastUsedAccountEmail", "switchMinBalance"]);
  if (!manual && settings.autoSwitchEnabled !== true) return;
  const accounts = await loadManagedAccounts();
  const minBalance = Number.isFinite(Number(settings.switchMinBalance))
    ? Number(settings.switchMinBalance)
    : DEFAULT_SWITCH_MIN_BALANCE;
  setToolbarStatus(`正在检查各账号余额（需 > $${minBalance}）...`);
  const balances = await ensureAccountBalances(accounts);
  const next = selectNextAccount(accounts, currentAccountEmail(), settings.lastUsedAccountEmail, {
    balances,
    minBalance
  });
  if (!next) {
    setToolbarStatus(`没有余额 > $${minBalance} 的可切换账号`, true);
    return;
  }
  setToolbarStatus(`将切换到 ${next.email} ...`);
  if (isSessionPage()) {
    await exportHandoffForSwitch();
  }
  const state = {
    phase: "loggingOut",
    targetEmail: next.email,
    startedAt: new Date().toISOString(),
    attempts: 0,
    manual
  };
  await saveAutoSwitchState(state);
  await driveLogout(state);
}

async function beginSwitchToAccount(email) {
  const target = String(email || "").trim();
  if (!target) {
    setToolbarStatus("目标账号邮箱为空", true);
    return;
  }
  const accounts = await loadManagedAccounts();
  const account = accounts.find((item) => (
    item && typeof item.email === "string" && item.email.trim().toLowerCase() === target.toLowerCase()
  ));
  if (!account || !account.password) {
    setToolbarStatus("该账号缺少密码，无法切换（请先在文本框补全后重新添加）", true);
    return;
  }
  if (account.email.trim().toLowerCase() === currentAccountEmail().trim().toLowerCase()) {
    setToolbarStatus(`当前已是 ${account.email}`, true);
    return;
  }
  setToolbarStatus(`正在切换到 ${account.email} ...`);
  if (isSessionPage()) {
    await exportHandoffForSwitch();
  }
  await saveAutoSwitchState({
    phase: "loggingOut",
    targetEmail: account.email,
    startedAt: new Date().toISOString(),
    attempts: 0,
    manual: true
  });
  await driveLogout({ phase: "loggingOut", targetEmail: account.email });
}

function isSessionPage() {
  return /^\/sessions\/[^/]+\/?$/.test(location.pathname);
}

let autoSwitchRunning = false;

async function runAutoSwitch() {
  if (autoSwitchRunning) return;
  autoSwitchRunning = true;
  try {
    const settings = await storageGet(["autoSwitchEnabled", "autoSwitchState"]);
    const state = settings.autoSwitchState || { phase: "idle" };
    const autoSwitchEnabled = settings.autoSwitchEnabled === true;
    const onSessionPage = isSessionPage();
    const action = routeAutoSwitch(location.href, state, {
      enabled: autoSwitchEnabled,
      quotaExceeded: autoSwitchEnabled && onSessionPage
        ? isQuotaExceededThrottled()
        : false,
      loggedOut: !localStorage.getItem("auth1_session")
    });
    if (action === "beginSwitch") await beginAutoSwitch(false);
    if (action === "driveLogout") await driveLogout(state);
    if (action === "driveLogin") {
      if (state.phase === "loggingOut") {
        await saveAutoSwitchState({ ...state, phase: "loggingIn", loginStep: "email" });
      }
      await driveLogin({ ...state, phase: "loggingIn", loginStep: state.loginStep || "email" });
    }
    if (action === "navigateLogin") {
      location.href = "https://app.devin.ai/auth/login?redirect=%2F";
    }
    if (action === "createSession") {
      await saveAutoSwitchState({ ...state, phase: "creatingSession" });
      await createContinuationSession({ ...state, phase: "creatingSession" });
    }
    if (action === "done") await saveAutoSwitchState({ ...state, phase: "done" });
  } catch (error) {
    await abortAutoSwitch(error.message || "自动换号失败");
  } finally {
    autoSwitchRunning = false;
  }
}

let accountDraft = [];
const accountBalanceCache = new Map();

const ACCOUNT_LINE_DELIMITERS = [
  /-{3,}/,
  /\t+/,
  /\|/,
  /,/,
  / {1,}/,
  /:/
];

function normalizeAccountObject(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  let email = "";
  let password = "";
  let label = "";
  for (const key of Object.keys(candidate)) {
    const normalized = key.toLowerCase();
    const value = candidate[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value).trim();
    if (!email && ["email", "username", "user", "account", "mail", "login"].includes(normalized)) {
      email = text;
    } else if (!password && ["password", "pass", "pwd", "pw", "secret"].includes(normalized)) {
      password = text;
    } else if (!label && ["label", "name", "tag", "note", "alias"].includes(normalized)) {
      label = text;
    }
  }
  if (!email.includes("@") || !password) return null;
  return { label: label || email, email, password };
}

function parseAccountLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  if (trimmed[0] === "{") {
    try {
      return normalizeAccountObject(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  for (const delimiter of ACCOUNT_LINE_DELIMITERS) {
    if (!delimiter.test(trimmed)) continue;
    const fields = trimmed.split(delimiter).map((field) => field.trim()).filter(Boolean);
    if (fields.length >= 2 && fields[0].includes("@")) {
      return { label: fields[0], email: fields[0], password: fields[1] };
    }
  }
  return null;
}

function parseBatchAccounts(text) {
  const raw = String(text || "");
  const accounts = [];
  let skipped = 0;
  const push = (account) => {
    if (account) accounts.push(account);
    else skipped += 1;
  };
  const trimmedAll = raw.trim();
  if (trimmedAll.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmedAll);
      if (Array.isArray(parsed)) {
        for (const item of parsed) push(normalizeAccountObject(item));
        return { accounts, skipped };
      }
    } catch {
      // Fall back to line-by-line parsing below.
    }
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    push(parseAccountLine(line));
  }
  return { accounts, skipped };
}

function mergeBatchAccounts(existing, text) {
  const merged = Array.isArray(existing) ? existing.map((account) => ({ ...account })) : [];
  const indexes = new Map(merged.map((account, index) => [
    String(account.email || "").trim().toLowerCase(),
    index
  ]));
  const parsed = parseBatchAccounts(text);
  for (const account of parsed.accounts) {
    const key = account.email.toLowerCase();
    const index = indexes.get(key);
    if (index == null) {
      indexes.set(key, merged.length);
      merged.push(account);
    } else {
      merged[index] = {
        ...merged[index],
        password: account.password,
        label: merged[index].label || account.label
      };
    }
  }
  return {
    accounts: merged,
    addedOrUpdated: parsed.accounts.length,
    skipped: parsed.skipped
  };
}

const BALANCE_STORAGE_KEY = "accountBalances";
const BALANCE_STALE_MS = 5 * 60 * 1000;

function isUsableBalance(info) {
  return Boolean(info) && !info.loading && Number.isFinite(accountAvailableBalance(info));
}

async function loadPersistedBalances() {
  try {
    const stored = await storageGet([BALANCE_STORAGE_KEY]);
    const saved = stored[BALANCE_STORAGE_KEY];
    if (saved && typeof saved === "object") {
      for (const [key, info] of Object.entries(saved)) {
        if (info && typeof info === "object" && !accountBalanceCache.has(key)) {
          accountBalanceCache.set(key, info);
        }
      }
    }
  } catch {
    // Missing/corrupt persisted balances are non-fatal.
  }
}

async function persistBalances() {
  const saved = {};
  for (const [key, info] of accountBalanceCache.entries()) {
    if (isUsableBalance(info)) {
      const { staleError, ...clean } = info;
      saved[key] = clean;
    }
  }
  try {
    await storageSet({ [BALANCE_STORAGE_KEY]: saved });
  } catch {
    // Persisting the balance cache is best-effort.
  }
}

function formatAccountBalance(info) {
  if (info?.loading) return "查询中…";
  if (isUsableBalance(info)) {
    return info.staleError ? `${formatBalanceDisplay(info)} · 刷新失败` : formatBalanceDisplay(info);
  }
  if (info?.error) return info.error;
  return "余额 — · 上限 —";
}

function accountBalanceClass(info) {
  if (isUsableBalance(info)) return balanceToneClass(info).replace("balance-", "account-balance-");
  if (info?.error) return "account-balance-error";
  return "";
}

async function readTargetUsageLimitSafe() {
  const stored = await storageGet(["targetUsageLimit"]);
  const value = Number(stored.targetUsageLimit);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TARGET_USAGE_LIMIT;
}

async function queryAccountBalance(account, options = {}) {
  const key = String(account.email || "").trim().toLowerCase();
  if (!key) return null;
  const previous = accountBalanceCache.get(key);
  accountBalanceCache.set(key, { loading: true });
  renderAccountRows();
  try {
    const info = options.provisionLimit != null
      ? await provisionAccount(account.email, account.password, options.provisionLimit)
      : await fetchBalanceForCredentials(account.email, account.password);
    info.fetchedAt = Date.now();
    accountBalanceCache.set(key, info);
    renderAccountRows();
    await persistBalances();
    return info;
  } catch (error) {
    // Keep the last known balance visible instead of blanking the row.
    const fallback = isUsableBalance(previous)
      ? { ...previous, staleError: error.message || "刷新失败" }
      : { error: error.message || "无法查询余额" };
    accountBalanceCache.set(key, fallback);
    renderAccountRows();
    return fallback;
  }
}

async function ensureAccountBalances(accounts) {
  await loadPersistedBalances();
  const map = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const key = accountKey(account);
    if (!key) continue;
    let info = accountBalanceCache.get(key);
    if (!isUsableBalance(info)) {
      info = await queryAccountBalance(account);
    }
    if (info) map.set(key, info);
  }
  return map;
}

function isFreshBalance(info) {
  return isUsableBalance(info)
    && !info.staleError
    && Number.isFinite(info.fetchedAt)
    && Date.now() - info.fetchedAt < BALANCE_STALE_MS;
}

const accountSessionsCache = new Map();
const accountLatestCache = new Map();
const selectedAccountKeys = new Set();
const LATEST_STORAGE_KEY = "accountLatestSessions";
const SESSION_STATUS_LABELS = {
  running: "正在运行",
  working: "正在运行",
  in_progress: "正在运行",
  resumed: "正在运行",
  blocked: "等待输入",
  waiting: "等待输入",
  waiting_for_user: "等待输入",
  finished: "已完成",
  completed: "已完成",
  done: "已完成",
  exit: "已结束",
  exited: "已结束",
  stopped: "已停止",
  paused: "已暂停",
  suspended: "已休眠",
  sleeping: "已休眠",
  archived: "已归档",
  cancelled: "已取消",
  canceled: "已取消",
  expired: "已过期",
  timeout: "超时",
  timed_out: "超时",
  error: "出错",
  failed: "失败",
  queued: "排队中",
  initializing: "准备中",
  starting: "准备中"
};

const SESSION_STATUS_ICONS = {
  正在运行: "🟢",
  等待输入: "🟡",
  已完成: "✅",
  已结束: "⚪",
  已停止: "⏹️",
  已暂停: "⏸️",
  已休眠: "😴",
  已归档: "📦",
  已取消: "🚫",
  已过期: "⌛",
  超时: "⌛",
  出错: "❌",
  失败: "❌",
  排队中: "⏳",
  准备中: "⏳",
  状态未知: "❔"
};

function sessionStatusIcon(status) {
  return SESSION_STATUS_ICONS[formatSessionStatus(status)] || "❔";
}

function accountKey(account) {
  return String(account?.email || "").trim().toLowerCase();
}

function pickLatestSession(sessions) {
  if (!Array.isArray(sessions) || !sessions.length) return null;
  const time = (session) => {
    const parsed = Date.parse(session.updatedAt || session.createdAt || "");
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  return [...sessions].sort((left, right) => time(right) - time(left))[0];
}

function formatSessionStatus(status) {
  const key = String(status || "").trim().toLowerCase();
  return SESSION_STATUS_LABELS[key] || status || "状态未知";
}

async function loadPersistedLatestSessions() {
  try {
    const stored = await storageGet([LATEST_STORAGE_KEY]);
    const saved = stored[LATEST_STORAGE_KEY];
    if (saved && typeof saved === "object") {
      for (const [key, info] of Object.entries(saved)) {
        if (info && typeof info === "object" && !accountLatestCache.has(key)) {
          accountLatestCache.set(key, info);
        }
      }
    }
  } catch {
    // Missing/corrupt persisted sessions are non-fatal.
  }
}

async function persistLatestSessions() {
  const saved = {};
  for (const [key, info] of accountLatestCache.entries()) {
    if (info && !info.loading && !info.error) saved[key] = info;
  }
  try {
    await storageSet({ [LATEST_STORAGE_KEY]: saved });
  } catch {
    // Best-effort.
  }
}

// Logs in once per account, then fills both the balance and latest-session
// caches so a panel refresh does not double the number of background logins.
async function refreshAccountMeta(account, options = {}) {
  const key = accountKey(account);
  if (!key) return;
  const prevBalance = accountBalanceCache.get(key);
  accountBalanceCache.set(key, { loading: true });
  accountLatestCache.set(key, { loading: true });
  renderAccountRows();
  try {
    const auth = await resolveAccountAuth(account.email, account.password);
    if (Number.isFinite(options.provisionLimit) && options.provisionLimit >= 0) {
      try {
        await setUsageLimit(options.provisionLimit, { orgId: auth.orgId, token: auth.token });
      } catch {
        // Balance/session info is still useful even if the limit update fails.
      }
    }
    const [balanceResult, sessionsResult] = await Promise.allSettled([
      fetchBalanceForAuth(auth),
      fetchSessionsForToken(auth.token, auth.orgId)
    ]);
    if (balanceResult.status === "fulfilled") {
      const info = balanceResult.value;
      info.fetchedAt = Date.now();
      accountBalanceCache.set(key, info);
    } else {
      accountBalanceCache.set(key, isUsableBalance(prevBalance)
        ? { ...prevBalance, staleError: balanceResult.reason?.message || "刷新失败" }
        : { error: balanceResult.reason?.message || "无法查询余额" });
    }
    if (sessionsResult.status === "fulfilled") {
      const latest = pickLatestSession(sessionsResult.value);
      accountLatestCache.set(key, {
        session: latest ? { sessionId: latest.sessionId, title: latest.title, status: latest.status } : null,
        fetchedAt: Date.now()
      });
    } else {
      accountLatestCache.set(key, { error: sessionsResult.reason?.message || "会话读取失败" });
    }
    renderAccountRows();
    await Promise.all([persistBalances(), persistLatestSessions()]);
  } catch (error) {
    const message = error.message || "登录失败";
    accountBalanceCache.set(key, isUsableBalance(prevBalance)
      ? { ...prevBalance, staleError: message }
      : { error: message });
    accountLatestCache.set(key, { error: message });
    renderAccountRows();
  }
}

async function refreshAccountsMeta(accounts) {
  for (const account of Array.isArray(accounts) ? accounts : []) {
    await refreshAccountMeta(account);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function refreshStaleAccountMeta() {
  for (const account of accountDraft) {
    const key = accountKey(account);
    const balanceFresh = isFreshBalance(accountBalanceCache.get(key));
    const latest = accountLatestCache.get(key);
    const latestFresh = latest && !latest.loading && !latest.error
      && Number.isFinite(latest.fetchedAt) && Date.now() - latest.fetchedAt < BALANCE_STALE_MS;
    if (balanceFresh && latestFresh) continue;
    await refreshAccountMeta(account);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function deleteSelectedAccounts() {
  if (!selectedAccountKeys.size) {
    setToolbarStatus("请先勾选要删除的账号", true);
    return;
  }
  const removed = selectedAccountKeys.size;
  accountDraft = accountDraft.filter((account) => {
    const key = accountKey(account);
    if (selectedAccountKeys.has(key)) {
      accountBalanceCache.delete(key);
      accountSessionsCache.delete(key);
      accountLatestCache.delete(key);
      return false;
    }
    return true;
  });
  selectedAccountKeys.clear();
  renderAccountRows();
  try {
    await saveManagedAccounts(accountDraft, encryptionEnabled);
    await Promise.all([persistBalances(), persistLatestSessions()]);
    setToolbarStatus(`已删除 ${removed} 个账号`);
  } catch (error) {
    setToolbarStatus(error.message || "删除后保存失败", true);
  }
}

async function toggleAccountSessions(account) {
  const key = accountKey(account);
  if (!key) return;
  const existing = accountSessionsCache.get(key);
  if (existing && !existing.loading && !existing.error) {
    existing.expanded = !existing.expanded;
    accountSessionsCache.set(key, existing);
    renderAccountRows();
    return;
  }
  accountSessionsCache.set(key, { loading: true, expanded: true, filter: "" });
  renderAccountRows();
  try {
    const { auth, sessions } = await fetchSessionsForCredentials(account.email, account.password);
    accountSessionsCache.set(key, { auth, sessions, expanded: true, filter: "" });
  } catch (error) {
    accountSessionsCache.set(key, { error: error.message || "无法查询会话", expanded: true });
  }
  renderAccountRows();
}

function openIsolatedSession(session, auth) {
  const url = buildIsolatedSessionUrl(session, auth);
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(url, "_blank", "noopener");
  }
}

async function openLatestSession(account, session) {
  setToolbarStatus(`正在打开：${session.title}…`);
  const auth = await resolveAccountAuth(account.email, account.password);
  openIsolatedSession(session, auth);
  setToolbarStatus(`已打开：${session.title}`);
}

async function exportSessionHandoff(session, auth) {
  setToolbarStatus(`正在导出会话 Handoff：${session.title}...`);
  const text = await exportListedSessionHandoff(session, auth);
  setToolbarStatus(`已导出会话：${session.title}`);
  return text;
}

async function shareSession(session, auth) {
  const stored = await storageGet(["shareServiceUrl"]);
  const serviceUrl = String(
    stored.shareServiceUrl || DEFAULT_SHARE_SERVICE_URL
  ).trim().replace(/\/+$/, "");
  if (!serviceUrl) {
    setToolbarStatus("请先在设置中配置分享服务地址", true);
    return "";
  }
  setToolbarStatus(`正在生成分享链接：${session.title}…`);
  const response = await fetch(`${serviceUrl}/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({
      token: auth.token,
      orgId: auth.orgId,
      devinId: session.devinId
    })
  });
  if (!response.ok) {
    throw new Error(`生成分享链接失败（HTTP ${response.status}）`);
  }
  const payload = await response.json();
  if (!payload?.url || typeof payload.url !== "string") {
    throw new Error("分享服务返回了无效链接");
  }
  const copied = await copyToClipboard(payload.url);
  if (!copied) {
    setToolbarStatus("分享链接已生成，但复制失败，请手动复制", true);
    return payload.url;
  }
  setToolbarStatus("已复制分享链接（对方可实时读取该会话；令牌过期或撤销后失效）");
  return payload.url;
}

function formatLatestSession(info) {
  if (!info) return "最新会话：—";
  if (info.loading) return "最新会话：查询中…";
  if (info.error) return `最新会话：${info.error}`;
  if (!info.session) return "最新会话：无";
  return `最新会话：${info.session.title} · ${formatSessionStatus(info.session.status)}`;
}

const PROMPT_SNIPPETS_KEY = "promptSnippets";
let promptSnippets = [];

async function loadPromptSnippets() {
  try {
    const stored = await storageGet([PROMPT_SNIPPETS_KEY]);
    const saved = stored[PROMPT_SNIPPETS_KEY];
    if (Array.isArray(saved)) {
      promptSnippets = saved.filter((item) => item && typeof item.text === "string");
    } else {
      // Seed once with the remote-cluster prompt as an example so it is not lost.
      promptSnippets = [{ title: "远程 GPU 集群接入", text: SAMPLE_REMOTE_PROMPT }];
      await storageSet({ [PROMPT_SNIPPETS_KEY]: promptSnippets });
    }
  } catch {
    promptSnippets = [];
  }
}

async function savePromptSnippets() {
  try {
    await storageSet({ [PROMPT_SNIPPETS_KEY]: promptSnippets });
  } catch {
    // Persisting snippets is best-effort.
  }
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

function renderPromptSnippets() {
  emit();
}

async function copySnippetToClipboard(text) {
  const ok = await copyToClipboard(text);
  setToolbarStatus(ok ? "已复制到剪贴板" : "复制失败，请手动复制", !ok);
  return ok;
}

async function addPromptSnippet(title, text) {
  const body = String(text || "").trim();
  if (!body) {
    setToolbarStatus("提示词内容不能为空", true);
    return false;
  }
  const label = String(title || "").trim() || body.slice(0, 24);
  promptSnippets.push({ title: label, text: body });
  await savePromptSnippets();
  emit();
  setToolbarStatus("已保存提示词");
  return true;
}

async function removePromptSnippet(index) {
  if (index < 0 || index >= promptSnippets.length) return;
  promptSnippets.splice(index, 1);
  await savePromptSnippets();
  emit();
}

function renderAccountRows() {
  emit();
}

function toggleAccountSelect(key) {
  if (selectedAccountKeys.has(key)) selectedAccountKeys.delete(key);
  else selectedAccountKeys.add(key);
  emit();
}

function setAllAccountsSelected(checked) {
  selectedAccountKeys.clear();
  if (checked) accountDraft.forEach((account) => selectedAccountKeys.add(accountKey(account)));
  emit();
}

function moveAccount(index, direction) {
  const target = index + direction;
  if (index < 0 || target < 0 || index >= accountDraft.length || target >= accountDraft.length) return;
  [accountDraft[index], accountDraft[target]] = [accountDraft[target], accountDraft[index]];
  emit();
}

// The batch textarea prefilled for editing a saved account (email---password[---label]).
function accountEditText(account) {
  const parts = [account.email || "", account.password || ""];
  if (account.label && account.label !== account.email) parts.push(account.label);
  return parts.join("---");
}

function exportAccounts(accounts = accountDraft) {
  return (Array.isArray(accounts) ? accounts : []).map(accountEditText).join("\n");
}

async function toggleAccountArchive(index) {
  const account = accountDraft[index];
  if (!account) return;
  account.archived = !account.archived;
  emit();
  try {
    await saveManagedAccounts(accountDraft, encryptionEnabled);
    setToolbarStatus(account.archived ? "已归档（仍保存、可查看，不参与自动换号）" : "已取消归档");
  } catch (error) {
    setToolbarStatus(error.message, true);
  }
}

function deleteAccount(key) {
  selectedAccountKeys.add(key);
  return deleteSelectedAccounts();
}

async function refreshAccountsBalances(onlySelected) {
  const targets = onlySelected
    ? accountDraft.filter((account) => selectedAccountKeys.has(accountKey(account)))
    : accountDraft.slice();
  await refreshAccountsMeta(targets);
}

async function addBatchAccounts(text) {
  const raw = String(text || "");
  if (!raw.trim()) {
    setToolbarStatus("请先在文本框填入账号（每行一个）", true);
    return false;
  }
  const before = new Set(accountDraft.map((account) => accountKey(account)));
  const result = mergeBatchAccounts(accountDraft, raw);
  accountDraft = result.accounts;
  const added = accountDraft.filter((account) => !before.has(accountKey(account)));
  for (const account of added) {
    accountBalanceCache.delete(accountKey(account));
    accountLatestCache.delete(accountKey(account));
  }
  emit();
  try {
    await saveManagedAccounts(accountDraft, encryptionEnabled);
  } catch (error) {
    setToolbarStatus(error.message || "保存账号失败", true);
    return false;
  }
  setToolbarStatus(`已添加/更新 ${result.addedOrUpdated} 个账号，跳过 ${result.skipped} 行，正在查询余额...`);
  const target = await readTargetUsageLimitSafe();
  for (const account of added) {
    await refreshAccountMeta(account, { provisionLimit: target });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  setToolbarStatus(`已添加/更新 ${result.addedOrUpdated} 个账号，余额与上限($${target})已就绪`);
  return true;
}

function validateLimit(raw, fallback, label) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label}必须是非负数字`);
  }
  return value;
}

async function saveSettings(settings = {}) {
  const targetUsageLimit = validateLimit(settings.targetUsageLimit, DEFAULT_TARGET_USAGE_LIMIT, "消息用量上限");
  const switchMinBalance = validateLimit(settings.switchMinBalance, DEFAULT_SWITCH_MIN_BALANCE, "最低余额");
  encryptionEnabled = settings.encryptionEnabled === true;
  await saveManagedAccounts(accountDraft, encryptionEnabled);
  await storageSet({
    autoSwitchEnabled: settings.autoSwitchEnabled === true,
    autoSendContinuation: settings.autoSendContinuation !== false,
    targetUsageLimit,
    switchMinBalance,
    theme: settings.theme === "dark" ? "dark" : "light",
    shareServiceUrl: typeof settings.shareServiceUrl === "string" && settings.shareServiceUrl.trim()
      ? settings.shareServiceUrl.trim()
      : DEFAULT_SHARE_SERVICE_URL,
    continuationTemplate: typeof settings.continuationTemplate === "string"
      ? settings.continuationTemplate
      : DEFAULT_HANDOFF_TEMPLATE
  });
  setToolbarStatus("账号设置已保存");
}

async function applyTargetUsageLimit(rawTarget) {
  try {
    const target = validateLimit(rawTarget, DEFAULT_TARGET_USAGE_LIMIT, "消息用量上限");
    await setUsageLimit(target);
    await storageSet({ targetUsageLimit: target });
    await refreshBalanceDisplay();
    setToolbarStatus(`当前账号消息上限已设为 $${target.toFixed(2)}`);
  } catch (error) {
    setToolbarStatus(error.message || "更新消息用量上限失败", true);
  }
}

function setEncryptionEnabled(value) {
  encryptionEnabled = value === true;
  emit();
}

// Loads persisted state for the settings panel and returns the values React
// needs to hydrate its controlled form. Kicks off background refreshes too.
async function loadSettingsState() {
  accountDraft = await loadManagedAccounts();
  const values = await storageGet([
    "accountEncryptionEnabled",
    "autoSwitchEnabled",
    "autoSendContinuation",
    "targetUsageLimit",
    "switchMinBalance",
    "continuationTemplate",
    "theme",
    "shareServiceUrl"
  ]);
  currentTheme = values.theme === "dark" ? "dark" : "light";
  try {
    globalThis.localStorage?.setItem("devin-exporter-theme", currentTheme);
  } catch {
    // Keep the in-memory default when localStorage is unavailable.
  }
  encryptionEnabled = values.accountEncryptionEnabled === true;
  selectedAccountKeys.clear();
  await Promise.all([loadPersistedBalances(), loadPersistedLatestSessions(), loadPromptSnippets()]);
  emit();
  checkForUpdate().catch(() => {});
  refreshCurrentAccount().catch((error) => setToolbarStatus(error.message, true));
  refreshStaleAccountMeta()
    .then(() => refreshCurrentAccount())
    .catch((error) => setToolbarStatus(error.message, true));
  return {
    settings: {
      theme: currentTheme,
      encryptionEnabled,
      autoSwitchEnabled: values.autoSwitchEnabled === true,
      autoSendContinuation: values.autoSendContinuation !== false,
      targetUsageLimit: Number.isFinite(Number(values.targetUsageLimit))
        ? Number(values.targetUsageLimit)
        : DEFAULT_TARGET_USAGE_LIMIT,
      switchMinBalance: Number.isFinite(Number(values.switchMinBalance))
        ? Number(values.switchMinBalance)
        : DEFAULT_SWITCH_MIN_BALANCE,
      shareServiceUrl: typeof values.shareServiceUrl === "string" && values.shareServiceUrl.trim()
        ? values.shareServiceUrl
        : DEFAULT_SHARE_SERVICE_URL
    },
    template: values.continuationTemplate || DEFAULT_HANDOFF_TEMPLATE
  };
}

async function exportHandoff() {
  if (!isSessionPage()) {
    throw new Error("请先打开 Devin 会话页面");
  }
  setToolbarStatus("正在导出 Handoff...");
  const result = await exportHandoffForSwitch({ includeFullConversation: true });
  setToolbarStatus(`已保存：${result.data.title || "Handoff"}`);
  return result;
}

async function copyContinuationToClipboard() {
  if (!isSessionPage()) {
    setToolbarStatus("请先打开 Devin 会话页面", true);
    return false;
  }
  try {
    const { compact } = await exportHandoff();
    const stored = await storageGet(["continuationTemplate"]);
    const text = buildContinuationText(
      stored.continuationTemplate || DEFAULT_HANDOFF_TEMPLATE,
      compact
    );
    const ok = await copyToClipboard(text);
    setToolbarStatus(ok ? "已复制续接内容" : "复制失败，请手动复制", !ok);
    return ok;
  } catch (error) {
    setToolbarStatus(error.message || "复制续接内容失败", true);
    return false;
  }
}

const UPDATE_CHECK_KEY = "lastUpdateCheck";
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LATEST_RELEASE_API = "https://api.github.com/repos/wookat/devin-session-exporter/releases/latest";
let updateAvailableVersion = "";

function currentExtensionVersion() {
  try {
    return extensionApi?.runtime?.getManifest?.().version || "";
  } catch {
    return "";
  }
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function renderUpdateNotice() {
  emit();
}

async function checkForUpdate(force = false) {
  try {
    const current = currentExtensionVersion();
    if (!current) return;
    if (!force) {
      const stored = await storageGet([UPDATE_CHECK_KEY]);
      const last = Number(stored[UPDATE_CHECK_KEY]);
      if (Number.isFinite(last) && Date.now() - last < UPDATE_CHECK_INTERVAL_MS) {
        renderUpdateNotice();
        return;
      }
    }
    const response = await fetch(LATEST_RELEASE_API, { headers: { accept: "application/vnd.github+json" } });
    await storageSet({ [UPDATE_CHECK_KEY]: Date.now() });
    if (!response.ok) return;
    const data = await response.json();
    const latest = String(data?.tag_name || "").replace(/^ext-v/i, "").trim();
    if (latest && compareVersions(latest, current) > 0) {
      updateAvailableVersion = latest;
    } else {
      updateAvailableVersion = "";
    }
    renderUpdateNotice();
  } catch {
    // Update checks are best-effort; ignore network/CORS failures.
  }
}


// ---------------------------------------------------------------------------
// Reactive store: framework-agnostic pub/sub the React layer subscribes to.
// UI-only state lives here so the core stays free of any DOM/React dependency.
// ---------------------------------------------------------------------------
let statusMessage = "";
let statusIsError = false;
let currentPhase = "idle";
let currentBalanceInfo = null;
let encryptionEnabled = false;
function readCachedTheme() {
  try {
    return globalThis.localStorage?.getItem("devin-exporter-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

let currentTheme = readCachedTheme();
let storeRevision = 0;
const storeListeners = new Set();

function emit() {
  storeRevision += 1;
  for (const listener of storeListeners) {
    try {
      listener();
    } catch {
      // A misbehaving subscriber must not break the others.
    }
  }
}

function subscribe(listener) {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}

function getRevision() {
  return storeRevision;
}

function getStatus() {
  return { message: statusMessage, isError: statusIsError };
}

function getPhase() {
  return currentPhase;
}

function getUpdateVersion() {
  return updateAvailableVersion;
}

function getCurrentEmail() {
  return currentEmailCache;
}

function getCurrentBalanceInfo() {
  return currentBalanceInfo;
}

function getAccounts() {
  return accountDraft;
}

function getSnippets() {
  return promptSnippets;
}

function getEncryptionEnabled() {
  return encryptionEnabled;
}

function getTheme() {
  return currentTheme;
}

function setTheme(value) {
  currentTheme = value === "dark" ? "dark" : "light";
  try {
    globalThis.localStorage?.setItem("devin-exporter-theme", currentTheme);
  } catch {
    // The extension storage value remains authoritative if localStorage is unavailable.
  }
  storageSet({ theme: currentTheme }).catch(() => {});
  emit();
  return currentTheme;
}

function isAccountSelected(key) {
  return selectedAccountKeys.has(key);
}

function getSelectedCount() {
  return accountDraft.filter((account) => selectedAccountKeys.has(accountKey(account))).length;
}

function getBalanceInfo(key) {
  return accountBalanceCache.get(key) || null;
}

function getLatestInfo(key) {
  return accountLatestCache.get(key) || null;
}

function getSessionsState(key) {
  return accountSessionsCache.get(key) || null;
}

function setSessionFilter(key, value) {
  const state = accountSessionsCache.get(key);
  if (!state) return;
  state.filter = value;
  accountSessionsCache.set(key, state);
  emit();
}

async function refreshBalanceDisplay() {
  try {
    const info = await fetchBillingInfo();
    currentBalanceInfo = info;
    emit();
    return info;
  } catch {
    currentBalanceInfo = null;
    emit();
    return null;
  }
}

async function refreshCurrentAccount() {
  const [email, info] = await Promise.all([
    resolveCurrentAccountEmail().catch(() => ""),
    fetchBillingInfo().catch(() => null)
  ]);
  currentEmailCache = email || "";
  if (info) currentBalanceInfo = info;
  emit();
}

export {
  // Pure helpers (also used by tests and the popup formatter path).
  buildMessages,
  buildWorklog,
  buildHandoff,
  collapseNoise,
  summarizeAttachmentMarkers,
  inlineAttachmentsInText,
  summarizeTodos,
  fileDateStamp,
  buildContinuationText,
  applyHandoff,
  buildUsageLimitBody,
  formatBalanceDisplay,
  formatBalanceOnly,
  accountAvailableBalance,
  balanceToneClass,
  parseBatchAccounts,
  parseAccountLine,
  normalizeAccountObject,
  mergeBatchAccounts,
  normalizeSessionRecord,
  pickLatestSession,
  formatSessionStatus,
  sessionStatusIcon,
  compareVersions,
  buildVauthPayload,
  buildIsolatedSessionUrl,
  selectNextAccount,
  routeAutoSwitch,
  isExtensionContextValid,
  // Constants.
  DEFAULT_HANDOFF_TEMPLATE,
  DEFAULT_TARGET_USAGE_LIMIT,
  DEFAULT_SWITCH_MIN_BALANCE,
  DEFAULT_SHARE_SERVICE_URL,
  UPDATE_CHECK_INTERVAL_MS,
  // Store.
  subscribe,
  getRevision,
  getStatus,
  getPhase,
  getUpdateVersion,
  getCurrentEmail,
  getCurrentBalanceInfo,
  getAccounts,
  getSnippets,
  getEncryptionEnabled,
  getTheme,
  isAccountSelected,
  getSelectedCount,
  getBalanceInfo,
  getLatestInfo,
  getSessionsState,
  setSessionFilter,
  accountKey,
  accountBalanceClass,
  formatAccountBalance,
  formatLatestSession,
  isSessionPage,
  setToolbarStatus,
  // Data / lifecycle actions.
  extractConversation,
  exportHandoff,
  copyContinuationToClipboard,
  continueFromClipboard,
  exportSessionHandoff,
  shareSession,
  refreshBalanceDisplay,
  refreshCurrentAccount,
  refreshAccountMeta,
  refreshStaleAccountMeta,
  loadSettingsState,
  saveSettings,
  setEncryptionEnabled,
  setTheme,
  applyTargetUsageLimit,
  addBatchAccounts,
  deleteAccount,
  deleteSelectedAccounts,
  refreshAccountsBalances,
  toggleAccountSelect,
  setAllAccountsSelected,
  moveAccount,
  toggleAccountArchive,
  accountEditText,
  exportAccounts,
  copyToClipboard,
  toggleAccountSessions,
  openLatestSession,
  openIsolatedSession,
  resolveAccountAuth,
  beginAutoSwitch,
  beginSwitchToAccount,
  copySnippetToClipboard,
  addPromptSnippet,
  removePromptSnippet,
  runAutoSwitch,
  checkForUpdate
};
