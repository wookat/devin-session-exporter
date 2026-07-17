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
      output: null
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
            contentsKey: update.contents_key ?? null
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
              : []
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
  module.exports = { buildMessages, buildWorklog };
}
