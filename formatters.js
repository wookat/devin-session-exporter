function formatTimestamp(timestamp) {
  return timestamp ? new Date(timestamp).toISOString() : "";
}

function messageLabel(message) {
  if (message.type === "devin_thoughts") {
    return "Devin (thinking)";
  }
  return message.role === "user" ? "User" : "Devin";
}

function toMarkdown(data) {
  const lines = [
    `# ${data.title || "Devin session"}`,
    "",
    `- Session URL: ${data.url}`,
    `- Exported at: ${formatTimestamp(data.exportedAt) || data.exportedAt}`,
    ""
  ];

  for (const message of data.messages || []) {
    lines.push(`## ${messageLabel(message)}`);
    if (message.timestamp) {
      lines.push(`_${formatTimestamp(message.timestamp)}_`);
    }
    lines.push("", message.text || "", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function toJSON(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function toText(data) {
  const lines = [
    data.title || "Devin session",
    `Session URL: ${data.url}`,
    `Exported at: ${formatTimestamp(data.exportedAt) || data.exportedAt}`,
    ""
  ];

  for (const message of data.messages || []) {
    const label = messageLabel(message);
    const timestamp = message.timestamp ? ` [${formatTimestamp(message.timestamp)}]` : "";
    lines.push(`${label}${timestamp}:`, message.text || "", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

const formatters = {
  markdown: toMarkdown,
  json: toJSON,
  text: toText
};

if (typeof module !== "undefined") {
  module.exports = { toMarkdown, toJSON, toText, formatters };
}
