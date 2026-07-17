const browserApi = globalThis.browser ?? globalThis.chrome;

const formatSelect = document.getElementById("format");
const includeConversationCheckbox = document.getElementById("include-conversation");
const includeWorklogCheckbox = document.getElementById("include-worklog");
const includeChangesCheckbox = document.getElementById("include-changes");
const includeThoughtsCheckbox = document.getElementById("include-thoughts");
const exportButton = document.getElementById("export");
const status = document.getElementById("status");

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

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

function downloadFile(filename, content, mimeType) {
  const dataUrl = `data:${mimeType},${encodeURIComponent(content)}`;

  if (browserApi.downloads?.download) {
    return extensionCall(
      browserApi.downloads.download.bind(browserApi.downloads),
      { url: dataUrl, filename, saveAs: true }
    );
  }

  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.click();
  return Promise.resolve();
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

async function getActiveTab() {
  return extensionCall(browserApi.tabs.query.bind(browserApi.tabs), {
    active: true,
    currentWindow: true
  }).then((tabs) => tabs[0]);
}

async function extractFromTab(tab) {
  try {
    return await extensionCall(browserApi.tabs.sendMessage.bind(browserApi.tabs), tab.id, {
      type: "extractConversation",
      options: {
        includeConversation: includeConversationCheckbox.checked,
        includeWorklog: includeWorklogCheckbox.checked,
        includeChanges: includeChangesCheckbox.checked,
        includeThoughts: includeThoughtsCheckbox.checked,
        includeQuestionAnswers: false
      }
    });
  } catch (error) {
    if (!browserApi.scripting?.executeScript) {
      throw error;
    }

    await extensionCall(
      browserApi.scripting.executeScript.bind(browserApi.scripting),
      { target: { tabId: tab.id }, files: ["content.js"] }
    );
    return extensionCall(browserApi.tabs.sendMessage.bind(browserApi.tabs), tab.id, {
      type: "extractConversation",
      options: {
        includeConversation: includeConversationCheckbox.checked,
        includeWorklog: includeWorklogCheckbox.checked,
        includeChanges: includeChangesCheckbox.checked,
        includeThoughts: includeThoughtsCheckbox.checked,
        includeQuestionAnswers: false
      }
    });
  }
}

function shortSessionId(sessionId) {
  return (sessionId || "session").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24);
}

function timestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "-" + [pad(date.getHours()), pad(date.getMinutes())].join("");
}

exportButton.addEventListener("click", async () => {
  const format = formatSelect.value;
  exportButton.disabled = true;
  setStatus("Extracting…");

  try {
    const tab = await getActiveTab();
    if (!tab?.id || !tab.url?.startsWith("https://app.devin.ai/sessions/")) {
      throw new Error("Open a Devin session page first.");
    }

    const response = await extractFromTab(tab);
    if (!response?.ok) {
      throw new Error(response?.error || "Conversation extraction failed.");
    }
    const data = response.data;
    const content = formatters[format](data);
    const filename = `devin-session-${shortSessionId(data.sessionId)}-${timestampForFilename()}.${extensionFor(format)}`;

    setStatus("Preparing download…");
    await downloadFile(filename, content, mimeTypeFor(format));
    setStatus("Export complete.");
  } catch (error) {
    setStatus(error.message || "Export failed.", true);
  } finally {
    exportButton.disabled = false;
  }
});
