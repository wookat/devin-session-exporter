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

  return {
    sessionId,
    url: window.location.href,
    title: metadata.title || document.title || "Devin session",
    exportedAt: new Date().toISOString(),
    orgId,
    messages: buildMessages(events, options)
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
  module.exports = { buildMessages };
}
