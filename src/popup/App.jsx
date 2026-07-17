import React, { useState } from "react";
import { formatters } from "../formatters.js";

const browserApi = globalThis.browser ?? globalThis.chrome;

function extensionCall(api, ...args) {
  if (globalThis.browser) {
    return api(...args);
  }
  return new Promise((resolve, reject) => {
    api(...args, (result) => {
      const error = browserApi.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function extensionFor(format) {
  return { markdown: "md", json: "json", text: "txt" }[format];
}

function mimeTypeFor(format) {
  return {
    markdown: "text/markdown;charset=utf-8",
    json: "application/json;charset=utf-8",
    text: "text/plain;charset=utf-8"
  }[format];
}

function shortSessionId(sessionId) {
  return (sessionId || "session").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24);
}

function timestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("") +
    "-" +
    [pad(date.getHours()), pad(date.getMinutes())].join("")
  );
}

async function getActiveTab() {
  const tabs = await extensionCall(browserApi.tabs.query.bind(browserApi.tabs), {
    active: true,
    currentWindow: true
  });
  return tabs[0];
}

async function downloadFile(filename, content, mimeType) {
  const dataUrl = `data:${mimeType},${encodeURIComponent(content)}`;
  if (browserApi.downloads?.download) {
    return extensionCall(browserApi.downloads.download.bind(browserApi.downloads), {
      url: dataUrl,
      filename,
      saveAs: true
    });
  }
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.click();
  return Promise.resolve();
}

export function App() {
  const [format, setFormat] = useState("markdown");
  const [includeConversation, setIncludeConversation] = useState(true);
  const [includeWorklog, setIncludeWorklog] = useState(false);
  const [includeChanges, setIncludeChanges] = useState(false);
  const [includeThoughts, setIncludeThoughts] = useState(false);
  const [status, setStatus] = useState({ message: "", isError: false });
  const [busy, setBusy] = useState(false);

  const onExport = async () => {
    setBusy(true);
    setStatus({ message: "Extracting…", isError: false });
    try {
      const tab = await getActiveTab();
      if (!tab?.id || !tab.url?.startsWith("https://app.devin.ai/sessions/")) {
        throw new Error("Open a Devin session page first.");
      }
      const response = await extensionCall(browserApi.tabs.sendMessage.bind(browserApi.tabs), tab.id, {
        type: "extractConversation",
        options: {
          includeConversation,
          includeWorklog,
          includeChanges,
          includeThoughts,
          includeQuestionAnswers: false
        }
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Conversation extraction failed.");
      }
      const data = response.data;
      const content = formatters[format](data);
      const filename = `devin-session-${shortSessionId(data.sessionId)}-${timestampForFilename()}.${extensionFor(format)}`;
      setStatus({ message: "Preparing download…", isError: false });
      await downloadFile(filename, content, mimeTypeFor(format));
      setStatus({ message: "Export complete.", isError: false });
    } catch (error) {
      setStatus({ message: error.message || "Export failed.", isError: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="popup">
      <h1>Devin Session Exporter</h1>
      <label htmlFor="format">Format</label>
      <select id="format" value={format} onChange={(event) => setFormat(event.target.value)}>
        <option value="markdown">Markdown</option>
        <option value="json">JSON</option>
        <option value="text">Plain text</option>
      </select>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={includeConversation}
          onChange={(event) => setIncludeConversation(event.target.checked)}
        />
        Include conversation
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={includeWorklog}
          onChange={(event) => setIncludeWorklog(event.target.checked)}
        />
        Include worklog
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={includeChanges}
          onChange={(event) => setIncludeChanges(event.target.checked)}
        />
        Include changes
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={includeThoughts}
          onChange={(event) => setIncludeThoughts(event.target.checked)}
        />
        Include Devin's thoughts
      </label>
      <button type="button" onClick={onExport} disabled={busy}>
        Export
      </button>
      <p className={status.isError ? "status error" : "status"} role="status" aria-live="polite">
        {status.message}
      </p>
    </main>
  );
}
