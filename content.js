const MESSAGE_TYPES = new Set([
  "initial_user_message",
  "user_message",
  "devin_message",
  "devin_thoughts",
  "user_question_answered"
]);

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
            thinkingDurationMs: event.thinking_duration_ms ?? null,
            isMajorAction: event.is_major_action === true
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

function handoffSafeText(value) {
  return String(value || "")
    .replace(/((?:api[_ -]?key|auth(?:entication)? key|token|password|secret)\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[private key redacted]");
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

const HANDOFF_COLLAPSE_PLACEHOLDER = "[续接自前序会话；完整历史见 xu-1 上的 ~/wookat 与 CONTINUATION.md]";

function collapsePriorHandoff(text) {
  const value = String(text || "");
  const markers = [
    "【上一会话的上下文（用于续接）】",
    "# Devin Context Handoff"
  ];
  const markerPositions = markers
    .map((marker) => value.indexOf(marker))
    .filter((position) => position >= 0);
  if (!markerPositions.length) {
    return value;
  }
  const markerPosition = Math.min(...markerPositions);
  const prefix = value.slice(0, markerPosition).trimEnd();
  return prefix
    ? `${prefix}\n${HANDOFF_COLLAPSE_PLACEHOLDER}`
    : HANDOFF_COLLAPSE_PLACEHOLDER;
}

function buildHandoff(data, options = {}) {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const worklog = Array.isArray(data.worklog) ? data.worklog : [];
  const collapsedMessages = messages.map((message) => (
    message.role === "user"
      ? { ...message, text: collapsePriorHandoff(message.text) }
      : message
  ));
  const userMessages = collapsedMessages.filter((message) => message.role === "user");
  const devinMessages = messages.filter((message) => (
    message.role === "devin" && message.type === "devin_message"
  ));
  const latestTodos = [...worklog].reverse().find((entry) => entry.kind === "todos");
  const environment = [];
  const files = uniqueValues(worklog
    .filter((entry) => entry.kind === "file" && entry.action !== "read")
    .map((entry) => entry.path)
    .filter((path) => path && !/(^|\/)(?:\.env|.*\.(?:pem|key))$|id_rsa/i.test(path)));

  for (const entry of worklog) {
    if (entry.kind !== "command") {
      continue;
    }
    const command = handoffSafeText(entry.command);
    const sshTargets = command.match(/\b(?:ssh|scp)\s+(?:-[^\s]+\s+)*(?:[\w.-]+@)?[\w.-]+/g) || [];
    environment.push(...sshTargets.map((target) => `Remote target: ${target}`));
    const clones = command.match(/\bgit\s+clone\s+\S+/g) || [];
    environment.push(...clones.map((clone) => `Repository: ${clone}`));
    const conda = command.match(/\bconda\s+(?:activate|create)\s+[^\s]+/g) || [];
    environment.push(...conda.map((item) => `Environment: ${item}`));
    if (entry.startingDir) {
      environment.push(`Working directory: ${handoffSafeText(entry.startingDir)}`);
    }
  }

  const majorActions = worklog
    .filter((entry) => entry.isMajorAction === true)
    .slice(-12)
    .map((entry) => {
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
    ...(userMessages.length
      ? userMessages.map((message, index) => `${index + 1}. ${handoffSafeText(message.text)}`)
      : ["No user messages captured."]),
    "",
    "## Key decisions, conclusions, and current direction",
    ...(devinMessages.length
      ? devinMessages.map((message) => `- ${handoffSafeText(message.text)}`)
      : ["No Devin conclusions captured."]),
    "",
    "## Current status",
    ...(latestTodos && Array.isArray(latestTodos.todos)
      ? latestTodos.todos.map((todo) => (
        `- ${todo.status === "completed" ? "[x]" : "[ ]"} ${handoffSafeText(todo.content)}`
      ))
      : ["No todo state captured."]),
    "",
    "## Environment and how to resume",
    ...(uniqueValues(environment).length ? uniqueValues(environment).map((item) => `- ${item}`) : [
      "Use the cluster-access instructions in the continuation template."
    ]),
    "",
    "## Files created or modified",
    ...(files.length ? files.map((file) => `- ${file}`) : ["No file edits captured."]),
    "",
    "## Recent major actions",
    ...(majorActions.length ? majorActions.map((action) => `- ${action}`) : ["No major actions captured."]),
    "",
  ];

  if (options.includeFullConversation !== false) {
    lines.push(
      "## Full conversation",
      "The following messages are the complete captured conversation:",
      ""
    );
    for (const message of collapsedMessages) {
      const label = message.role === "user" ? "User" : "Devin";
      lines.push(`### ${label}`, handoffSafeText(message.text), "");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

const extensionApi = globalThis.browser ?? globalThis.chrome;

function storageGet(keys) {
  if (!extensionApi?.storage?.local) {
    return Promise.resolve({});
  }
  if (globalThis.browser) {
    return extensionApi.storage.local.get(keys);
  }
  return new Promise((resolve, reject) => {
    extensionApi.storage.local.get(keys, (result) => {
      const error = extensionApi.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function storageSet(values) {
  if (!extensionApi?.storage?.local) {
    return Promise.resolve();
  }
  if (globalThis.browser) {
    return extensionApi.storage.local.set(values);
  }
  return new Promise((resolve, reject) => {
    extensionApi.storage.local.set(values, () => {
      const error = extensionApi.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function isSessionPage() {
  return /^\/sessions\/[^/]+\/?$/.test(window.location.pathname);
}

function injectComposerText(text) {
  const candidates = [...document.querySelectorAll("textarea, [contenteditable='true']")]
    .filter((element) => {
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    });
  const composer = candidates.find((element) => (
    /ask devin|build features|fix bugs|work on your code/i.test(
      element.getAttribute("placeholder") || ""
    )
  )) || candidates[0];

  if (!composer) {
    throw new Error("Could not find the Devin message composer");
  }

  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    setter?.call(composer, text);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    composer.textContent = text;
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
  }
}

function downloadHandoff(text, title) {
  const dataUrl = `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;
  const filename = `devin-handoff-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  if (extensionApi?.downloads?.download) {
    if (globalThis.browser) {
      return extensionApi.downloads.download({ url: dataUrl, filename, saveAs: true });
    }
    return new Promise((resolve, reject) => {
      extensionApi.downloads.download({ url: dataUrl, filename, saveAs: true }, (id) => {
        const error = extensionApi.runtime?.lastError;
        if (error) reject(new Error(error.message));
        else resolve(id);
      });
    });
  }
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.click();
  return Promise.resolve(title);
}

function toolbarStatus(message, isError = false) {
  const status = document.getElementById("devin-exporter-status");
  if (status) {
    status.textContent = message;
    status.dataset.error = isError ? "true" : "false";
  }
}

async function exportHandoffInPage() {
  if (!isSessionPage()) {
    throw new Error("Open a Devin session page first");
  }
  toolbarStatus("正在提取...");
  const data = await extractConversation({
    includeConversation: true,
    includeWorklog: true,
    includeChanges: true,
    includeThoughts: false
  });
  const handoff = buildHandoff(data);
  const savedAt = new Date().toISOString();
  await storageSet({
    lastHandoff: {
      text: handoff,
      exportedAt: savedAt,
      title: data.title,
      url: data.url
    }
  });
  await downloadHandoff(handoff, data.title);
  toolbarStatus("Handoff 已保存");
}

function applyHandoff(template, handoff) {
  if (handoff) {
    return template.includes("{{HANDOFF}}")
      ? template.replace(/\{\{HANDOFF\}\}/g, handoff)
      : `${template.trimEnd()}\n\n---\n\n${handoff}`;
  }
  return template;
}

async function continueWithHandoff() {
  const stored = await storageGet(["continuationTemplate", "lastHandoff"]);
  const template = stored.continuationTemplate || DEFAULT_HANDOFF_TEMPLATE;
  const handoff = stored.lastHandoff?.text || "";
  injectComposerText(applyHandoff(template, handoff));
  toolbarStatus(handoff ? "已填入续接提示，请检查后发送" : "未找到 Handoff，已填入模板");
}

async function openTemplateSettings() {
  const panel = document.getElementById("devin-exporter-settings");
  if (!panel) return;
  const textarea = panel.querySelector("textarea");
  const stored = await storageGet(["continuationTemplate"]);
  textarea.value = stored.continuationTemplate || DEFAULT_HANDOFF_TEMPLATE;
  panel.hidden = false;
  textarea.focus();
}

function installToolbar() {
  if (document.getElementById("devin-exporter-toolbar")) {
    updateToolbarState();
    return;
  }

  const style = document.createElement("style");
  style.id = "devin-exporter-style";
  style.textContent = `
    #devin-exporter-toolbar, #devin-exporter-settings {
      position: fixed; z-index: 2147483647; right: 18px; bottom: 18px;
      font: 13px system-ui, sans-serif; color: #172033;
    }
    #devin-exporter-toolbar {
      display: flex; gap: 6px; align-items: center; padding: 8px;
      border: 1px solid #c9d2e3; border-radius: 8px; background: #fff;
      box-shadow: 0 3px 14px #0002;
    }
    #devin-exporter-toolbar button, #devin-exporter-settings button {
      border: 1px solid #aab7cc; border-radius: 5px; background: #f7f9fc;
      color: #172033; padding: 5px 8px; cursor: pointer;
    }
    #devin-exporter-toolbar button:disabled { cursor: not-allowed; opacity: .5; }
    #devin-exporter-status { max-width: 180px; color: #315b8f; }
    #devin-exporter-status[data-error="true"] { color: #b3261e; }
    #devin-exporter-settings {
      right: 18px; bottom: 70px; width: 360px; padding: 12px;
      border: 1px solid #c9d2e3; border-radius: 8px; background: #fff;
      box-shadow: 0 3px 14px #0002;
    }
    #devin-exporter-settings textarea {
      display: block; width: 100%; height: 320px; box-sizing: border-box;
      margin: 8px 0; font: 12px/1.4 ui-monospace, monospace;
    }
    #devin-exporter-settings-actions { display: flex; gap: 6px; }
  `;
  document.documentElement.appendChild(style);

  const toolbar = document.createElement("div");
  toolbar.id = "devin-exporter-toolbar";
  toolbar.innerHTML = `
    <button id="devin-export-handoff" type="button">导出 Handoff</button>
    <button id="devin-continue-handoff" type="button">一键续接</button>
    <button id="devin-exporter-settings-button" type="button" aria-label="设置">设置</button>
    <span id="devin-exporter-status" role="status"></span>
  `;
  document.body.appendChild(toolbar);

  const panel = document.createElement("div");
  panel.id = "devin-exporter-settings";
  panel.hidden = true;
  panel.innerHTML = `
    <strong>续接模板</strong>
    <textarea aria-label="续接模板"></textarea>
    <div id="devin-exporter-settings-actions">
      <button id="devin-exporter-save-template" type="button">保存</button>
      <button id="devin-exporter-reset-template" type="button">恢复默认</button>
      <button id="devin-exporter-close-settings" type="button">关闭</button>
    </div>
  `;
  document.body.appendChild(panel);

  toolbar.querySelector("#devin-export-handoff").addEventListener("click", () => {
    exportHandoffInPage().catch((error) => toolbarStatus(error.message, true));
  });
  toolbar.querySelector("#devin-continue-handoff").addEventListener("click", () => {
    continueWithHandoff().catch((error) => toolbarStatus(error.message, true));
  });
  toolbar.querySelector("#devin-exporter-settings-button").addEventListener("click", () => {
    openTemplateSettings().catch((error) => toolbarStatus(error.message, true));
  });
  panel.querySelector("#devin-exporter-save-template").addEventListener("click", async () => {
    await storageSet({ continuationTemplate: panel.querySelector("textarea").value });
    panel.hidden = true;
    toolbarStatus("模板已保存");
  });
  panel.querySelector("#devin-exporter-reset-template").addEventListener("click", () => {
    panel.querySelector("textarea").value = DEFAULT_HANDOFF_TEMPLATE;
  });
  panel.querySelector("#devin-exporter-close-settings").addEventListener("click", () => {
    panel.hidden = true;
  });
  updateToolbarState();
}

function updateToolbarState() {
  const button = document.getElementById("devin-export-handoff");
  if (button) {
    button.disabled = !isSessionPage();
    button.title = button.disabled ? "请先打开 Devin 会话页面" : "";
  }
}

function maintainToolbar() {
  if (document.body) {
    installToolbar();
    updateToolbarState();
  }
}

if (typeof document !== "undefined") {
  maintainToolbar();
  new MutationObserver(maintainToolbar).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  setInterval(updateToolbarState, 1000);
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
    DEFAULT_HANDOFF_TEMPLATE,
    buildMessages,
    buildWorklog,
    buildHandoff,
    applyHandoff
  };
}
