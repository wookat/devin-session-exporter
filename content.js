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

function buildHandoff(data, options = {}) {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const worklog = Array.isArray(data.worklog) ? data.worklog : [];
  const collapsedMessages = messages.map((message) => (
    message.role === "user"
      ? { ...message, text: collapsePriorHandoff(message.text) }
      : message
  ));
  const users = collapsedMessages.filter((message) => message.role === "user");
  const decisions = messages.filter((message) => (
    message.role === "devin" && message.type === "devin_message"
  ));
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
  const lines = [
    "# Devin Context Handoff",
    "",
    `Source session: ${data.title || "Devin session"}`,
    `Source URL: ${data.url || ""}`,
    `Exported at: ${data.exportedAt || ""}`,
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
    ...(latestTodos && Array.isArray(latestTodos.todos)
      ? latestTodos.todos.map((todo) => `- ${todo.status === "completed" ? "[x]" : "[ ]"} ${handoffSafeText(todo.content)}`)
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
  if (options.includeFullConversation !== false) {
    lines.push("", "## Full conversation", "The following messages are the complete captured conversation:", "");
    for (const message of collapsedMessages) {
      lines.push(`### ${message.role === "user" ? "User" : "Devin"}`, handoffSafeText(message.text), "");
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

function selectNextAccount(accounts, currentEmail, lastUsedEmail = "") {
  const ordered = Array.isArray(accounts) ? accounts.filter((account) => (
    account && typeof account.email === "string" && account.email.trim()
  )) : [];
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
const AUTO_SWITCH_KEYS = [
  "managedAccounts",
  "accountVault",
  "accountEncryptionEnabled",
  "autoSwitchEnabled",
  "autoSendContinuation",
  "autoSwitchState",
  "lastHandoff",
  "lastUsedAccountEmail",
  "continuationTemplate"
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
  const stored = await storageGet(["continuationTemplate", "lastHandoff", "autoSendContinuation"]);
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
  const handoff = buildHandoff(data, {
    includeFullConversation: options.includeFullConversation === true
  });
  await storageSet({
    lastHandoff: {
      text: handoff,
      exportedAt: new Date().toISOString(),
      title: data.title,
      url: data.url
    }
  });
  return data;
}

async function beginAutoSwitch(manual = false) {
  const settings = await storageGet(["autoSwitchEnabled", "lastUsedAccountEmail"]);
  if (!manual && settings.autoSwitchEnabled !== true) return;
  const accounts = await loadManagedAccounts();
  const next = selectNextAccount(accounts, currentAccountEmail(), settings.lastUsedAccountEmail);
  if (!next) {
    setToolbarStatus("没有可用的下一个账号", true);
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
let editingAccountIndex = -1;

function toolbarPhase(state) {
  const phase = document.getElementById("devin-exporter-phase");
  if (phase) phase.textContent = `状态：${state?.phase || "idle"}`;
}

function renderAccountRows() {
  const list = document.getElementById("devin-account-list");
  if (!list) return;
  list.textContent = "";
  accountDraft.forEach((account, index) => {
    const row = document.createElement("div");
    row.className = "devin-account-row";
    const label = document.createElement("span");
    label.textContent = `${index + 1}. ${account.label || account.email}`;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => {
      document.getElementById("devin-account-label").value = account.label || "";
      document.getElementById("devin-account-email").value = account.email || "";
      document.getElementById("devin-account-password").value = account.password || "";
      editingAccountIndex = index;
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      accountDraft.splice(index, 1);
      renderAccountRows();
    });
    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "上移";
    up.disabled = index === 0;
    up.addEventListener("click", () => {
      [accountDraft[index - 1], accountDraft[index]] = [accountDraft[index], accountDraft[index - 1]];
      renderAccountRows();
    });
    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "下移";
    down.disabled = index === accountDraft.length - 1;
    down.addEventListener("click", () => {
      [accountDraft[index], accountDraft[index + 1]] = [accountDraft[index + 1], accountDraft[index]];
      renderAccountRows();
    });
    row.append(label, edit, remove, up, down);
    list.appendChild(row);
  });
}

async function openSettingsPanel() {
  const panel = document.getElementById("devin-exporter-settings");
  if (!panel) return;
  try {
    accountDraft = await loadManagedAccounts();
    const values = await storageGet(["accountEncryptionEnabled", "autoSwitchEnabled", "autoSendContinuation"]);
    panel.querySelector("#devin-encrypt-accounts").checked = values.accountEncryptionEnabled === true;
    panel.querySelector("#devin-auto-switch").checked = values.autoSwitchEnabled === true;
    panel.querySelector("#devin-auto-send").checked = values.autoSendContinuation !== false;
    renderAccountRows();
    panel.hidden = false;
  } catch (error) {
    setToolbarStatus(error.message, true);
  }
}

async function saveSettingsPanel() {
  const panel = document.getElementById("devin-exporter-settings");
  if (!panel) return;
  const label = panel.querySelector("#devin-account-label");
  const email = panel.querySelector("#devin-account-email");
  const password = panel.querySelector("#devin-account-password");
  if (email.value.trim() || password.value) {
    const account = {
      label: label.value.trim(),
      email: email.value.trim(),
      password: password.value
    };
    if (!account.email || !account.password) {
      setToolbarStatus("账号邮箱和密码都必须填写", true);
      return;
    }
    if (editingAccountIndex >= 0) accountDraft[editingAccountIndex] = account;
    else accountDraft.push(account);
    editingAccountIndex = -1;
    label.value = "";
    email.value = "";
    password.value = "";
    renderAccountRows();
  }
  const encrypted = panel.querySelector("#devin-encrypt-accounts").checked;
  await saveManagedAccounts(accountDraft, encrypted);
  await storageSet({
    autoSwitchEnabled: panel.querySelector("#devin-auto-switch").checked,
    autoSendContinuation: panel.querySelector("#devin-auto-send").checked
  });
  panel.hidden = true;
  setToolbarStatus("账号设置已保存");
}

function addAccountFromPanel() {
  const panel = document.getElementById("devin-exporter-settings");
  const label = panel.querySelector("#devin-account-label");
  const email = panel.querySelector("#devin-account-email");
  const password = panel.querySelector("#devin-account-password");
  if (!email.value.trim() || !password.value) {
    setToolbarStatus("账号邮箱和密码都必须填写", true);
    return;
  }
  const account = {
    label: label.value.trim(),
    email: email.value.trim(),
    password: password.value
  };
  if (editingAccountIndex >= 0) accountDraft[editingAccountIndex] = account;
  else accountDraft.push(account);
  editingAccountIndex = -1;
  label.value = "";
  email.value = "";
  password.value = "";
  renderAccountRows();
  setToolbarStatus("账号已加入列表，请保存设置");
}

async function exportHandoffInPage() {
  if (!isSessionPage()) {
    setToolbarStatus("请先打开 Devin 会话页面", true);
    return;
  }
  try {
    setToolbarStatus("正在导出 Handoff...");
    const data = await exportHandoffForSwitch({ includeFullConversation: true });
    const text = (await storageGet(["lastHandoff"])).lastHandoff.text;
    const link = document.createElement("a");
    link.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;
    link.download = `devin-handoff-${Date.now()}.md`;
    link.click();
    setToolbarStatus(`已保存：${data.title || "Handoff"}`);
  } catch (error) {
    setToolbarStatus(error.message || "Handoff 导出失败", true);
  }
}

function installToolbar() {
  if (document.getElementById("devin-exporter-toolbar")) return;
  const style = document.createElement("style");
  style.id = "devin-exporter-style";
  style.textContent = `
    #devin-exporter-toolbar,#devin-exporter-settings{position:fixed;z-index:2147483647;right:18px;bottom:18px;font:13px system-ui,sans-serif;color:#172033}
    #devin-exporter-toolbar{display:flex;gap:6px;align-items:center;padding:8px;border:1px solid #c9d2e3;border-radius:8px;background:#fff;box-shadow:0 3px 14px #0002}
    #devin-exporter-toolbar button,#devin-exporter-settings button{border:1px solid #aab7cc;border-radius:5px;background:#f7f9fc;color:#172033;padding:5px 8px;cursor:pointer}
    #devin-exporter-toolbar button:disabled{cursor:not-allowed;opacity:.5}
    #devin-exporter-status{max-width:220px;color:#315b8f} #devin-exporter-status[data-error=true]{color:#b3261e}
    #devin-exporter-phase{font-size:11px;color:#58657a}
    #devin-exporter-settings{right:18px;bottom:72px;width:440px;max-height:80vh;overflow:auto;padding:12px;border:1px solid #c9d2e3;border-radius:8px;background:#fff;box-shadow:0 3px 14px #0002}
    #devin-exporter-settings input{box-sizing:border-box;width:100%;margin:3px 0;padding:5px}
    #devin-exporter-settings textarea{width:100%;height:180px;box-sizing:border-box}
    .devin-account-row{display:flex;gap:4px;align-items:center;margin:5px 0}.devin-account-row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .devin-settings-actions{display:flex;gap:5px;margin-top:8px}
  `;
  document.documentElement.appendChild(style);
  const toolbar = document.createElement("div");
  toolbar.id = "devin-exporter-toolbar";
  toolbar.innerHTML = `
    <button id="devin-export-handoff" type="button">导出 Handoff</button>
    <button id="devin-manual-switch" type="button">换到下一个号</button>
    <button id="devin-settings-button" type="button">设置</button>
    <span id="devin-exporter-phase">状态：idle</span>
    <span id="devin-exporter-status" role="status"></span>
  `;
  document.body.appendChild(toolbar);
  const panel = document.createElement("div");
  panel.id = "devin-exporter-settings";
  panel.hidden = true;
  panel.innerHTML = `
    <strong>账号管理</strong>
    <p>账号密码仅用于本地自动登录；建议启用主密码加密。此功能可能触发服务条款、封号和本地密码存储风险，仅支持无 2FA 的邮箱密码账号。</p>
    <div id="devin-account-list"></div>
    <input id="devin-account-label" type="text" placeholder="账号标签">
    <input id="devin-account-email" type="email" placeholder="邮箱">
    <input id="devin-account-password" type="password" placeholder="密码">
    <div class="devin-settings-actions"><button id="devin-account-add" type="button">添加/更新账号</button></div>
    <label><input id="devin-encrypt-accounts" type="checkbox"> 使用主密码加密账号列表</label>
    <label><input id="devin-auto-switch" type="checkbox"> 启用自动换号</label>
    <label><input id="devin-auto-send" type="checkbox" checked> 自动发送续接</label>
    <hr>
    <strong>续接模板</strong>
    <textarea id="devin-template" placeholder="续接模板"></textarea>
    <div class="devin-settings-actions">
      <button id="devin-save-settings" type="button">保存设置</button>
      <button id="devin-reset-template" type="button">恢复默认模板</button>
      <button id="devin-close-settings" type="button">关闭</button>
    </div>
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
  panel.querySelector("#devin-account-add").addEventListener("click", addAccountFromPanel);
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
}

function updateToolbar() {
  const exportButton = document.getElementById("devin-export-handoff");
  if (exportButton) exportButton.disabled = !isSessionPage();
  storageGet(["autoSwitchState"]).then((stored) => toolbarPhase(stored.autoSwitchState)).catch(() => {});
}

const isAppHost = typeof location !== "undefined" && location.hostname === "app.devin.ai";
const isAutoSwitchHost = isAppHost
  || (typeof location !== "undefined" && location.hostname === "devin.ai");

if (typeof document !== "undefined" && isAutoSwitchHost) {
  if (isAppHost) {
    installToolbar();
    updateToolbar();
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
    buildContinuationText,
    applyHandoff,
    selectNextAccount,
    routeAutoSwitch
  };
}
