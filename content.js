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
    orgName: auth.orgName
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

async function exportListedSessionHandoff(session, auth) {
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
  return buildHandoff(data, { includeFullConversation: false });
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
      headers: apiHeaders(token, orgId)
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
      headers: apiHeaders(token, orgId)
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

const DEFAULT_HANDOFF_TEMPLATE = `你现在需要接入并使用我的远程 GPU 集群。当前阶段不要自行选择项目，也不要运行训练；先完成连接、了解集群使用方法，然后等待我提供具体任务。

【接入方式】

1. 检查 Tailscale：
   tailscale status

2. 如果没有安装：
   curl -fsSL https://tailscale.com/install.sh | sh

3. 需要 Tailscale auth key 时向我索取。不要把密钥保存到代码、脚本、日志或文档中。

4. 接入后连接主服务器：
   ssh dell@xu-1

5. 如果出现 Tailscale Check 授权链接，把完整链接发给我，等待我放行。

【集群结构】

- xu-1：统一入口、代码和实验产物的长期存储节点，也可以参与训练；
- xu-2、xu-3、xu-4：训练节点；
- temp-www、temp-lx：可参与调度的临时训练节点；
- temp-hb：禁止加入自动调度，只能在我明确要求时单独连接使用。

已经配置从 xu-1 到训练节点的免交互 SSH。连接 xu-1 后，正常情况下不需要再次向我索取其他节点的密码或授权。

集群使用轻量 SSH GPU 调度器 \`sgpu\`，不使用 SLURM。登录 xu-1 后，先查找并阅读现有的 sgpu 帮助、配置和使用说明，例如：

sgpu --help

如果命令不在 PATH 中，请在不修改系统环境的前提下查找其实际位置、README 或管理脚本。不要重新安装、重写或替换现有调度器。

【使用规则】

1. GPU 训练任务优先通过 sgpu 提交，不要直接登录节点抢占 GPU。
2. 提交前检查节点、GPU、运行任务和排队任务状态。
3. 不要重复提交已经运行或排队的任务。
4. 不要停止、修改或干扰其他用户及其他项目的任务。
5. 不要让前台 SSH 会话承载长时间训练；任务应在 Devin 断开后继续运行。
6. 代码可以从 xu-1 同步到计算节点，但训练节点不能作为唯一存储位置。
7. 日志、指标、结果、checkpoint 和重要权重必须回传 xu-1。
8. 不清理 temp-* 上的任何文件。
9. 不修改服务器现有的 Python、Conda、CUDA、驱动或系统环境。
10. temp-hb 不得通过 sgpu 使用，除非我明确要求人工单独连接它。

【完成接入后的汇报】

先进行只读检查，然后告诉我：

- Tailscale 和 xu-1 是否连接成功；
- sgpu 的实际位置和基本调用方式；
- 当前可调度节点；
- 各节点当前是否在线以及 GPU 是否空闲；
- 当前运行和排队中的任务；
- 如何提交、查看日志、取消任务和取回结果；
- 你准备使用的标准提交命令模板。

当前只检查和学习，不提交训练、不取消任务、不修改配置。完成汇报后等待我提供项目目录和训练命令。

项目创建在~/wookat下面，所有证据和材料都需要保证到xu-1服务器上，当前设备作为临时的，随时可能切换到新的设备新的会话继续完成任务。

【上一会话的上下文（用于续接）】

以下是上一个会话导出的交接信息。接入 xu-1 后，请先阅读 ~/wookat 下的项目目录与已保存的证据/材料，再结合下面的上下文继续未完成的任务；若与「等待我提供任务」冲突，以继续未完成任务为准。

{{HANDOFF}}
`;

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
    ...(majorText.length ? majorText.map((item) => `- ${item}`) : ["No major actions captured."])
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
    account && typeof account.email === "string" && account.email.trim()
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

function storageGet(keys = AUTO_SWITCH_KEYS) {
  if (!extensionApi?.storage?.local) return Promise.resolve({});
  if (globalThis.browser) return extensionApi.storage.local.get(keys);
  return new Promise((resolve, reject) => {
    extensionApi.storage.local.get(keys, (result) => {
      const error = extensionApi.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result || {});
    });
  });
}

function storageSet(values) {
  if (!extensionApi?.storage?.local) return Promise.resolve();
  if (globalThis.browser) return extensionApi.storage.local.set(values);
  return new Promise((resolve, reject) => {
    extensionApi.storage.local.set(values, () => {
      const error = extensionApi.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function storageRemove(keys) {
  if (!extensionApi?.storage?.local) return Promise.resolve();
  if (globalThis.browser) return extensionApi.storage.local.remove(keys);
  return new Promise((resolve, reject) => {
    extensionApi.storage.local.remove(keys, () => {
      const error = extensionApi.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
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

function isQuotaExceeded() {
  const text = document.body?.innerText || "";
  return /usage quota exceeded|usage quota has been exceeded|out of on-demand usage|ran out of free credits/i.test(text);
}

function findButtonContaining(text) {
  return [...document.querySelectorAll("button")].find((button) => {
    const style = getComputedStyle(button);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && (button.innerText || button.textContent || "").trim().toLowerCase().includes(text.toLowerCase());
  });
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

function setToolbarStatus(message, isError = false) {
  const element = document.getElementById("devin-exporter-status");
  if (element) {
    element.textContent = message;
    element.dataset.error = isError ? "true" : "false";
  }
}

async function saveAutoSwitchState(state) {
  await storageSet({ autoSwitchState: state });
  const phase = document.getElementById("devin-exporter-phase");
  if (phase) phase.textContent = `状态：${state.phase || "idle"}`;
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
    setTimeout(() => createContinuationSession(state).catch((error) => setToolbarStatus(error.message, true)), 800);
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
  setToolbarStatus(shouldSend ? "已发送续接提示" : "已填入续接提示");
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
    const action = routeAutoSwitch(location.href, state, {
      enabled: settings.autoSwitchEnabled === true,
      quotaExceeded: isQuotaExceeded(),
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

async function refreshStaleAccountBalances() {
  for (const account of accountDraft) {
    if (isFreshBalance(accountBalanceCache.get(accountKey(account)))) continue;
    await queryAccountBalance(account);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function refreshAllAccountBalances() {
  for (const account of accountDraft) {
    await queryAccountBalance(account);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const accountSessionsCache = new Map();

function accountKey(account) {
  return String(account?.email || "").trim().toLowerCase();
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

async function exportSessionFromList(session, auth, button) {
  setButtonLoading(button, true);
  try {
    setToolbarStatus(`正在导出会话 Handoff：${session.title}...`);
    const text = await exportListedSessionHandoff(session, auth);
    const link = document.createElement("a");
    link.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;
    link.download = `devin-handoff-${session.sessionId.slice(0, 12)}-${fileDateStamp()}.md`;
    link.click();
    setToolbarStatus(`已导出会话：${session.title}`);
  } catch (error) {
    setToolbarStatus(error.message || "会话 Handoff 导出失败", true);
  } finally {
    setButtonLoading(button, false);
  }
}

function renderAccountSessions(container, account) {
  const key = accountKey(account);
  const state = accountSessionsCache.get(key);
  if (!state || !state.expanded) return;
  const panel = document.createElement("div");
  panel.className = "devin-account-sessions";
  if (state.loading) {
    panel.textContent = "正在读取会话列表…";
    container.appendChild(panel);
    return;
  }
  if (state.error) {
    panel.className = "devin-account-sessions devin-account-balance-error";
    panel.textContent = state.error;
    container.appendChild(panel);
    return;
  }
  const search = document.createElement("input");
  search.type = "search";
  search.className = "devin-session-filter";
  search.placeholder = `搜索 ${state.sessions.length} 个会话…`;
  search.value = state.filter || "";
  search.addEventListener("input", () => {
    state.filter = search.value;
    accountSessionsCache.set(key, state);
    renderAccountSessionsList(listWrap, account, state);
  });
  panel.appendChild(search);
  const listWrap = document.createElement("div");
  listWrap.className = "devin-session-list";
  panel.appendChild(listWrap);
  container.appendChild(panel);
  renderAccountSessionsList(listWrap, account, state);
}

function renderAccountSessionsList(listWrap, account, state) {
  listWrap.textContent = "";
  const needle = String(state.filter || "").trim().toLowerCase();
  const filtered = state.sessions.filter((session) => {
    if (!needle) return true;
    return `${session.title} ${session.sessionId}`.toLowerCase().includes(needle);
  });
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "devin-session-empty";
    empty.textContent = state.sessions.length ? "没有匹配的会话" : "该账号没有会话";
    listWrap.appendChild(empty);
    return;
  }
  for (const session of filtered.slice(0, 100)) {
    const row = document.createElement("div");
    row.className = "devin-session-row";
    const title = document.createElement("span");
    title.className = "devin-session-title";
    title.title = session.title;
    title.textContent = session.status ? `${session.title} · ${session.status}` : session.title;
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "打开(不换号)";
    open.addEventListener("click", () => openIsolatedSession(session, state.auth));
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.textContent = "导出Handoff";
    exportBtn.addEventListener("click", () => exportSessionFromList(session, state.auth, exportBtn));
    row.append(title, open, exportBtn);
    listWrap.appendChild(row);
  }
}

function toolbarPhase(state) {
  const phase = document.getElementById("devin-exporter-phase");
  if (phase) phase.textContent = `状态：${state?.phase || "idle"}`;
}

function renderAccountRows() {
  const list = document.getElementById("devin-account-list");
  if (!list) return;
  list.textContent = "";
  accountDraft.forEach((account, index) => {
    const key = accountKey(account);
    const row = document.createElement("div");
    row.className = "devin-account-row";
    const top = document.createElement("div");
    top.className = "devin-account-top";
    const identity = document.createElement("div");
    identity.className = "devin-account-identity";
    const label = document.createElement("strong");
    label.textContent = `${index + 1}. ${account.label || account.email}`;
    const email = document.createElement("span");
    email.textContent = account.email;
    identity.append(label, email);
    const balance = document.createElement("span");
    const balanceInfo = accountBalanceCache.get(key);
    balance.className = `devin-account-balance ${accountBalanceClass(balanceInfo)}`;
    balance.textContent = formatAccountBalance(balanceInfo);
    top.append(identity, balance);

    const actions = document.createElement("div");
    actions.className = "devin-account-actions";
    const makeButton = (text, handler, extraClass) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      if (extraClass) button.className = extraClass;
      button.addEventListener("click", handler);
      return button;
    };
    const sessionsState = accountSessionsCache.get(key);
    actions.append(
      makeButton("查余额", () => queryAccountBalance(account)),
      makeButton(sessionsState?.expanded ? "收起会话" : "会话", () => {
        toggleAccountSessions(account).catch((error) => setToolbarStatus(error.message, true));
      }),
      makeButton("编辑", () => {
        const textarea = document.getElementById("devin-batch-accounts");
        if (textarea) {
          const parts = [account.email || "", account.password || ""];
          if (account.label) parts.push(account.label);
          textarea.value = parts.join("---");
          textarea.focus();
        }
        setToolbarStatus("已填入文本框，修改后点「添加账号」按相同邮箱更新");
      }),
      makeButton("删除", () => {
        accountBalanceCache.delete(key);
        accountSessionsCache.delete(key);
        accountDraft.splice(index, 1);
        renderAccountRows();
      })
    );
    const up = makeButton("↑", () => {
      [accountDraft[index - 1], accountDraft[index]] = [accountDraft[index], accountDraft[index - 1]];
      renderAccountRows();
    });
    up.disabled = index === 0;
    const down = makeButton("↓", () => {
      [accountDraft[index], accountDraft[index + 1]] = [accountDraft[index + 1], accountDraft[index]];
      renderAccountRows();
    });
    down.disabled = index === accountDraft.length - 1;
    actions.append(up, down);

    row.append(top, actions);
    renderAccountSessions(row, account);
    list.appendChild(row);
  });
}

async function openSettingsPanel() {
  const panel = document.getElementById("devin-exporter-settings");
  if (!panel) return;
  try {
    accountDraft = await loadManagedAccounts();
    const values = await storageGet([
      "accountEncryptionEnabled",
      "autoSwitchEnabled",
      "autoSendContinuation",
      "targetUsageLimit",
      "switchMinBalance"
    ]);
    panel.querySelector("#devin-encrypt-accounts").checked = values.accountEncryptionEnabled === true;
    panel.querySelector("#devin-auto-switch").checked = values.autoSwitchEnabled === true;
    panel.querySelector("#devin-auto-send").checked = values.autoSendContinuation !== false;
    panel.querySelector("#devin-target-limit").value = Number.isFinite(Number(values.targetUsageLimit))
      ? Number(values.targetUsageLimit)
      : DEFAULT_TARGET_USAGE_LIMIT;
    panel.querySelector("#devin-switch-min-balance").value = Number.isFinite(Number(values.switchMinBalance))
      ? Number(values.switchMinBalance)
      : DEFAULT_SWITCH_MIN_BALANCE;
    await loadPersistedBalances();
    renderAccountRows();
    panel.hidden = false;
    refreshStaleAccountBalances().catch((error) => setToolbarStatus(error.message, true));
  } catch (error) {
    setToolbarStatus(error.message, true);
  }
}

async function saveSettingsPanel() {
  const panel = document.getElementById("devin-exporter-settings");
  if (!panel) return;
  const encrypted = panel.querySelector("#devin-encrypt-accounts").checked;
  const targetUsageLimit = readTargetUsageLimit(panel);
  const switchMinBalance = readSwitchMinBalance(panel);
  await saveManagedAccounts(accountDraft, encrypted);
  await storageSet({
    autoSwitchEnabled: panel.querySelector("#devin-auto-switch").checked,
    autoSendContinuation: panel.querySelector("#devin-auto-send").checked,
    targetUsageLimit,
    switchMinBalance
  });
  panel.hidden = true;
  setToolbarStatus("账号设置已保存");
}

async function addBatchAccountsFromPanel() {
  const panel = document.getElementById("devin-exporter-settings");
  if (!panel) return;
  const textarea = panel.querySelector("#devin-batch-accounts");
  if (!textarea.value.trim()) {
    setToolbarStatus("请先在文本框填入账号（每行一个）", true);
    return;
  }
  const before = new Set(accountDraft.map((account) => accountKey(account)));
  const result = mergeBatchAccounts(accountDraft, textarea.value);
  accountDraft = result.accounts;
  const added = accountDraft.filter((account) => !before.has(accountKey(account)));
  for (const account of added) accountBalanceCache.delete(accountKey(account));
  textarea.value = "";
  renderAccountRows();
  try {
    await saveManagedAccounts(
      accountDraft,
      panel.querySelector("#devin-encrypt-accounts").checked
    );
  } catch (error) {
    setToolbarStatus(error.message || "保存账号失败", true);
    return;
  }
  setToolbarStatus(`已添加/更新 ${result.addedOrUpdated} 个账号，跳过 ${result.skipped} 行，正在查询余额...`);
  const target = await readTargetUsageLimitSafe();
  for (const account of added) {
    await queryAccountBalance(account, { provisionLimit: target });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  setToolbarStatus(`已添加/更新 ${result.addedOrUpdated} 个账号，余额与上限($${target})已就绪`);
}

function readTargetUsageLimit(panel) {
  const raw = panel.querySelector("#devin-target-limit").value;
  if (String(raw).trim() === "") return DEFAULT_TARGET_USAGE_LIMIT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("消息用量上限必须是非负数字");
  }
  return value;
}

function readSwitchMinBalance(panel) {
  const raw = panel.querySelector("#devin-switch-min-balance").value;
  if (String(raw).trim() === "") return DEFAULT_SWITCH_MIN_BALANCE;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("最低余额必须是非负数字");
  }
  return value;
}

async function applyTargetUsageLimit() {
  const panel = document.getElementById("devin-exporter-settings");
  if (!panel) return;
  try {
    const target = readTargetUsageLimit(panel);
    await setUsageLimit(target);
    await storageSet({ targetUsageLimit: target });
    await refreshBalanceDisplay();
    setToolbarStatus(`当前账号消息上限已设为 $${target.toFixed(2)}`);
  } catch (error) {
    setToolbarStatus(error.message || "更新消息用量上限失败", true);
  }
}

function setButtonLoading(button, loading) {
  if (!button) return;
  if (loading) {
    button.classList.add("is-loading");
    button.disabled = true;
  } else {
    button.classList.remove("is-loading");
    button.disabled = false;
  }
}

async function exportHandoffInPage() {
  if (!isSessionPage()) {
    setToolbarStatus("请先打开 Devin 会话页面", true);
    return;
  }
  const button = document.getElementById("devin-export-handoff");
  setButtonLoading(button, true);
  try {
    setToolbarStatus("正在导出 Handoff...");
    const { data, compact, full } = await exportHandoffForSwitch({ includeFullConversation: true });
    const text = full || compact;
    const link = document.createElement("a");
    link.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;
    link.download = `devin-handoff-${fileDateStamp()}.md`;
    link.click();
    setToolbarStatus(`已保存：${data.title || "Handoff"}`);
  } catch (error) {
    setToolbarStatus(error.message || "Handoff 导出失败", true);
  } finally {
    setButtonLoading(button, false);
  }
}

function installToolbar() {
  if (document.getElementById("devin-exporter-toolbar")) return;
  const style = document.createElement("style");
  style.id = "devin-exporter-style";
  style.textContent = `
    #devin-exporter-toolbar,#devin-exporter-settings{position:fixed;z-index:2147483647;font:13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e6e9ef;color-scheme:dark}
    @keyframes devin-spin{to{transform:rotate(360deg)}}
    #devin-exporter-toolbar{right:16px;bottom:16px;display:flex;gap:6px;align-items:center;max-width:calc(100vw - 32px);padding:6px;border:1px solid #262b34;border-radius:12px;background:#12161dF2}
    #devin-exporter-toolbar button,#devin-exporter-settings button{border:0;border-radius:8px;background:#222835;color:#e6e9ef;padding:7px 11px;cursor:pointer;transition:background .12s}
    #devin-exporter-toolbar button:hover,#devin-exporter-settings button:hover{background:#2d3542}
    #devin-exporter-toolbar #devin-export-handoff{background:#2f6bff;color:#fff;font-weight:600}
    #devin-exporter-toolbar #devin-export-handoff:hover{background:#4179ff}
    #devin-exporter-toolbar button:disabled{cursor:default;opacity:.55}
    #devin-exporter-toolbar button.is-loading::after,#devin-exporter-settings button.is-loading::after{content:"";display:inline-block;width:12px;height:12px;margin-left:8px;border:2px solid #ffffff66;border-top-color:#fff;border-radius:50%;vertical-align:-2px;animation:devin-spin .7s linear infinite}
    #devin-exporter-balance{padding:5px 9px;border-radius:8px;background:#1a1f28;color:#aab3c1;white-space:nowrap;font-variant-numeric:tabular-nums}
    #devin-exporter-balance.balance-negative{background:#2c1c20;color:#ff9ba3}
    #devin-exporter-balance.balance-positive{background:#16241d;color:#84dcae}
    #devin-exporter-status{max-width:220px;overflow:hidden;color:#9aa4b2;text-overflow:ellipsis;white-space:nowrap}
    #devin-exporter-status[data-error=true]{color:#ff9ba3}
    #devin-exporter-phase{display:none}
    #devin-exporter-settings{right:16px;bottom:66px;width:min(500px,calc(100vw - 32px));max-height:82vh;overflow:auto;padding:16px 18px;border:1px solid #262b34;border-radius:14px;background:#12161dFA}
    #devin-exporter-settings h2{margin:0 0 2px;font-size:16px;font-weight:600;color:#f2f4f8}
    #devin-exporter-settings h3{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:#8a93a3}
    #devin-exporter-settings p{margin:6px 0 10px;font-size:12px;color:#7f8896;line-height:1.5}
    #devin-exporter-settings input,#devin-exporter-settings textarea{box-sizing:border-box;width:100%;margin:4px 0;padding:8px 10px;border:1px solid #2a303b;border-radius:8px;background:#0d1117;color:#e6e9ef;outline:none}
    #devin-exporter-settings input:focus,#devin-exporter-settings textarea:focus{border-color:#2f6bff}
    #devin-exporter-settings textarea{height:130px;resize:vertical}
    #devin-exporter-settings label{display:flex;gap:8px;align-items:center;margin:8px 0;font-size:13px;color:#c1c9d6}
    #devin-exporter-settings label input{width:auto;margin:0}
    .devin-settings-section{padding:14px 0;border-top:1px solid #20262f}
    .devin-settings-section:first-of-type{border-top:0;padding-top:4px}
    .devin-settings-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    .devin-account-row{display:flex;flex-direction:column;gap:6px;margin:6px 0;padding:9px 10px;border-radius:10px;background:#171b23}
    .devin-account-top{display:flex;gap:8px;align-items:center;justify-content:space-between}
    .devin-account-identity{min-width:0;display:flex;flex-direction:column;gap:1px}
    .devin-account-identity strong{overflow:hidden;font-weight:600;color:#e6e9ef;text-overflow:ellipsis;white-space:nowrap}
    .devin-account-identity span{overflow:hidden;font-size:11px;color:#7f8896;text-overflow:ellipsis;white-space:nowrap}
    .devin-account-balance{flex:none;font-size:12px;color:#aab3c1;white-space:nowrap;font-variant-numeric:tabular-nums}
    .devin-account-balance-negative,.devin-account-balance-error{color:#ff9ba3}
    .devin-account-balance-positive{color:#84dcae}
    .devin-account-actions{display:flex;flex-wrap:wrap;gap:5px}
    .devin-account-actions button{padding:4px 9px;font-size:12px;background:#1e242e}
    .devin-account-sessions{margin-top:4px;padding:8px;border-radius:8px;background:#0d1117}
    .devin-session-filter{margin:0 0 7px}
    .devin-session-list{display:flex;flex-direction:column;gap:4px;max-height:230px;overflow:auto}
    .devin-session-row{display:flex;gap:6px;align-items:center;padding:4px 2px}
    .devin-session-title{flex:1;min-width:0;overflow:hidden;font-size:12px;color:#c1c9d6;text-overflow:ellipsis;white-space:nowrap}
    .devin-session-row button{padding:3px 8px;font-size:11px;white-space:nowrap;background:#1e242e}
    .devin-session-empty{padding:4px 2px;font-size:12px;color:#7f8896}
  `;
  document.documentElement.appendChild(style);
  const toolbar = document.createElement("div");
  toolbar.id = "devin-exporter-toolbar";
  toolbar.innerHTML = `
    <button id="devin-export-handoff" type="button">导出 Handoff</button>
    <button id="devin-manual-switch" type="button">换到下一个号</button>
    <button id="devin-settings-button" type="button">设置</button>
    <span id="devin-exporter-balance">余额 —</span>
    <span id="devin-exporter-phase"></span>
    <span id="devin-exporter-status" role="status"></span>
  `;
  document.body.appendChild(toolbar);
  const panel = document.createElement("div");
  panel.id = "devin-exporter-settings";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="devin-settings-header"><h2>Devin Exporter 设置</h2></div>
    <section class="devin-settings-section">
      <h3>账号</h3>
      <p>添加后自动把用量上限设为目标值并查询余额。密码仅本地保存，建议启用加密；仅支持无 2FA 的邮箱密码账号。</p>
      <div id="devin-account-list"></div>
      <textarea id="devin-batch-accounts" placeholder="每行一个账号（可填一条或多条）：邮箱---密码---可选备注"></textarea>
      <div class="devin-settings-actions"><button id="devin-batch-add" type="button">添加账号</button></div>
    </section>
    <section class="devin-settings-section">
      <h3>余额与切号</h3>
      <input id="devin-target-limit" type="number" min="0" step="0.01" placeholder="用量上限（美元，默认 200）">
      <input id="devin-switch-min-balance" type="number" min="0" step="0.01" placeholder="可切号的最低余额（美元，默认 65）">
      <div class="devin-settings-actions">
        <button id="devin-apply-limit" type="button">应用上限到当前账号</button>
        <button id="devin-refresh-all-balances" type="button">刷新全部余额</button>
      </div>
    </section>
    <section class="devin-settings-section">
      <h3>自动换号</h3>
      <label><input id="devin-encrypt-accounts" type="checkbox"> 主密码加密账号列表</label>
      <label><input id="devin-auto-switch" type="checkbox"> 启用自动换号（仅切余额充足的号）</label>
      <label><input id="devin-auto-send" type="checkbox" checked> 自动发送续接</label>
    </section>
    <section class="devin-settings-section">
      <h3>续接模板</h3>
      <textarea id="devin-template" placeholder="续接模板"></textarea>
      <div class="devin-settings-actions">
        <button id="devin-save-settings" type="button">保存设置</button>
        <button id="devin-reset-template" type="button">恢复默认模板</button>
        <button id="devin-close-settings" type="button">关闭</button>
      </div>
    </section>
  `;
  document.body.appendChild(panel);
  toolbar.querySelector("#devin-export-handoff").addEventListener("click", exportHandoffInPage);
  toolbar.querySelector("#devin-manual-switch").addEventListener("click", () => {
    beginAutoSwitch(true).catch((error) => setToolbarStatus(error.message, true));
  });
  toolbar.querySelector("#devin-settings-button").addEventListener("click", () => {
    openSettingsPanel().then(async () => {
      const stored = await storageGet(["continuationTemplate"]);
      panel.querySelector("#devin-template").value = stored.continuationTemplate || DEFAULT_HANDOFF_TEMPLATE;
    }).catch((error) => setToolbarStatus(error.message, true));
  });
  panel.querySelector("#devin-batch-add").addEventListener("click", () => {
    addBatchAccountsFromPanel().catch((error) => setToolbarStatus(error.message, true));
  });
  panel.querySelector("#devin-apply-limit").addEventListener("click", applyTargetUsageLimit);
  panel.querySelector("#devin-refresh-all-balances").addEventListener("click", () => {
    refreshAllAccountBalances().catch((error) => setToolbarStatus(error.message, true));
  });
  panel.querySelector("#devin-save-settings").addEventListener("click", saveSettingsPanel);
  panel.querySelector("#devin-reset-template").addEventListener("click", () => {
    panel.querySelector("#devin-template").value = DEFAULT_HANDOFF_TEMPLATE;
  });
  panel.querySelector("#devin-close-settings").addEventListener("click", () => {
    panel.hidden = true;
  });
  const templateSave = panel.querySelector("#devin-save-settings");
  templateSave.addEventListener("click", async () => {
    await storageSet({ continuationTemplate: panel.querySelector("#devin-template").value });
  });
  refreshBalanceDisplay();
}

function updateToolbar() {
  const exportButton = document.getElementById("devin-export-handoff");
  if (exportButton) exportButton.disabled = !isSessionPage();
  storageGet(["autoSwitchState"]).then((stored) => toolbarPhase(stored.autoSwitchState)).catch(() => {});
}

async function refreshBalanceDisplay() {
  const element = document.getElementById("devin-exporter-balance");
  if (!element) return;
  try {
    const info = await fetchBillingInfo();
    element.textContent = formatBalanceDisplay(info);
    element.className = balanceToneClass(info);
  } catch {
    element.textContent = "余额 —";
    element.className = "";
  }
}

const isAppHost = typeof location !== "undefined" && location.hostname === "app.devin.ai";
const isAutoSwitchHost = isAppHost
  || (typeof location !== "undefined" && location.hostname === "devin.ai");

if (typeof document !== "undefined" && isAutoSwitchHost) {
  if (isAppHost) {
    installToolbar();
    updateToolbar();
    setInterval(() => refreshBalanceDisplay(), 30000);
    new MutationObserver(() => {
      installToolbar();
      updateToolbar();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  runAutoSwitch().catch((error) => setToolbarStatus(error.message, true));
  setInterval(() => {
    if (isAppHost) {
      installToolbar();
      updateToolbar();
    }
    runAutoSwitch().catch((error) => setToolbarStatus(error.message, true));
  }, 1500);
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "extractConversation") {
      return false;
    }

    extractConversation(message.options)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "Conversation extraction failed"
      }));
    return true;
  });
}

if (typeof module !== "undefined") {
  module.exports = {
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
    accountAvailableBalance,
    balanceToneClass,
    parseBatchAccounts,
    parseAccountLine,
    normalizeAccountObject,
    mergeBatchAccounts,
    normalizeSessionRecord,
    buildVauthPayload,
    buildIsolatedSessionUrl,
    selectNextAccount,
    routeAutoSwitch
  };
}
