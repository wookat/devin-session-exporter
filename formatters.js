function formatTimestamp(timestamp) {
  return timestamp ? new Date(timestamp).toISOString() : "";
}

function messageLabel(message) {
  if (message.type === "devin_thoughts") {
    return "Devin (thinking)";
  }
  return message.role === "user" ? "User" : "Devin";
}

function sectionEnabled(data, section) {
  return !data.sections || data.sections[section] !== false;
}

function changeEntries(changes) {
  if (!changes
    || (Array.isArray(changes) && changes.length === 0)
    || (typeof changes === "object" && !Array.isArray(changes)
      && Object.keys(changes).length === 0)) {
    return [];
  }
  if (changes.error) {
    return [{ error: changes.error }];
  }

  const readEntry = (value, path) => {
    if (typeof value === "string") {
      return { path, diff: value };
    }
    if (value && typeof value === "object") {
      return {
        path: value.path || value.file_path || value.filename || path || null,
        diff: value.diff || value.patch || value.unified || null,
        content: value.contents || value.content || value.new_contents || null,
        oldContent: value.old_contents || null,
        raw: value
      };
    }
    return { path, raw: value };
  };

  if (Array.isArray(changes)) {
    const entries = changes.map((item) => readEntry(item, null));
    return entries.length ? entries : [{ raw: changes }];
  }
  if (typeof changes === "object") {
    const entries = Object.entries(changes).map(([path, value]) => readEntry(value, path));
    return entries.length ? entries : [{ raw: changes }];
  }
  return [{ raw: changes }];
}

function renderChangeMarkdown(changes) {
  const entries = changeEntries(changes);
  if (!entries.length) {
    return ["No file changes found.", ""];
  }
  const lines = [];
  for (const entry of entries) {
    if (entry.error) {
      lines.push(`Changes unavailable: ${entry.error}`, "");
      continue;
    }
    lines.push(`### ${entry.path || "Unknown file"}`);
    if (entry.diff) {
      lines.push("```diff", entry.diff, "```", "");
    } else if (entry.content || entry.oldContent) {
      if (entry.oldContent) lines.push("Old content:", "```", entry.oldContent, "```");
      if (entry.content) lines.push("Content:", "```", entry.content, "```");
      lines.push("");
    } else {
      lines.push("```json", JSON.stringify(entry.raw ?? entry, null, 2), "```", "");
    }
  }
  return lines;
}

function renderWorklogMarkdown(worklog) {
  const lines = [];
  for (const entry of worklog || []) {
    switch (entry.kind) {
      case "thought":
        lines.push(`Thought: ${entry.text}`, "");
        break;
      case "command":
        lines.push(`$ ${entry.command || "(command unavailable)"}`, "```text");
        if (entry.exitCode != null) lines.push(`exit ${entry.exitCode}`);
        if (entry.output) lines.push(entry.output);
        lines.push("```", "");
        break;
      case "file":
        lines.push(
          entry.action === "read"
            ? `Read ${entry.path || "unknown file"}`
            : `Edit ${entry.path || "unknown file"} (lines ${entry.startLine ?? "?"}-${entry.endLine ?? "?"})`,
          ""
        );
        break;
      case "search":
        lines.push(`Search: ${entry.regex || "(pattern unavailable)"} in ${entry.path || "unknown path"}`, "");
        break;
      case "todos":
        lines.push("Todos:");
        for (const todo of entry.todos || []) {
          lines.push(`${todo.status === "completed" ? "[x]" : "[ ]"} ${todo.content || ""}`);
        }
        lines.push("");
        break;
      case "status":
        lines.push(`Status: ${entry.text}`, "");
        break;
      default:
        break;
    }
  }
  return lines;
}

function toMarkdown(data) {
  const lines = [
    `# ${data.title || "Devin session"}`,
    "",
    `- Session URL: ${data.url}`,
    `- Exported at: ${formatTimestamp(data.exportedAt) || data.exportedAt}`,
    ""
  ];

  if (sectionEnabled(data, "conversation")) {
    for (const message of data.messages || []) {
      lines.push(`## ${messageLabel(message)}`);
      if (message.timestamp) {
        lines.push(`_${formatTimestamp(message.timestamp)}_`);
      }
      lines.push("", message.text || "", "");
    }
  }
  if (sectionEnabled(data, "worklog")) {
    lines.push("## Worklog", "", ...renderWorklogMarkdown(data.worklog));
  }
  if (sectionEnabled(data, "changes")) {
    lines.push("## Changes", "", ...renderChangeMarkdown(data.changes));
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function toJSON(data) {
  const output = {
    ...data,
    messages: sectionEnabled(data, "conversation") ? data.messages || [] : [],
    worklog: sectionEnabled(data, "worklog") ? data.worklog || [] : [],
    changes: sectionEnabled(data, "changes") ? data.changes : null
  };
  return `${JSON.stringify(output, null, 2)}\n`;
}

function toText(data) {
  const lines = [
    data.title || "Devin session",
    `Session URL: ${data.url}`,
    `Exported at: ${formatTimestamp(data.exportedAt) || data.exportedAt}`,
    ""
  ];

  if (sectionEnabled(data, "conversation")) {
    for (const message of data.messages || []) {
      const label = messageLabel(message);
      const timestamp = message.timestamp ? ` [${formatTimestamp(message.timestamp)}]` : "";
      lines.push(`${label}${timestamp}:`, message.text || "", "");
    }
  }
  if (sectionEnabled(data, "worklog")) {
    lines.push("Worklog:");
    for (const entry of data.worklog || []) {
      if (entry.kind === "thought") lines.push(`Thought: ${entry.text}`);
      if (entry.kind === "command") {
        lines.push(`$ ${entry.command || "(command unavailable)"}`);
        if (entry.exitCode != null) lines.push(`exit ${entry.exitCode}`);
        if (entry.output) lines.push(entry.output);
      }
      if (entry.kind === "file") {
        lines.push(entry.action === "read"
          ? `Read ${entry.path || "unknown file"}`
          : `Edit ${entry.path || "unknown file"} (lines ${entry.startLine ?? "?"}-${entry.endLine ?? "?"})`);
      }
      if (entry.kind === "search") lines.push(`Search: ${entry.regex || "(pattern unavailable)"} in ${entry.path || "unknown path"}`);
      if (entry.kind === "todos") {
        lines.push("Todos:");
        for (const todo of entry.todos || []) lines.push(`${todo.status === "completed" ? "[x]" : "[ ]"} ${todo.content || ""}`);
      }
      if (entry.kind === "status") lines.push(`Status: ${entry.text}`);
    }
    lines.push("");
  }
  if (sectionEnabled(data, "changes")) {
    lines.push("Changes:");
    for (const entry of changeEntries(data.changes)) {
      if (entry.error) lines.push(`Changes unavailable: ${entry.error}`);
      else if (entry.diff) lines.push(`${entry.path || "Unknown file"}:\n${entry.diff}`);
      else lines.push(`${entry.path || "Unknown file"}:\n${entry.content || JSON.stringify(entry.raw ?? entry)}`);
    }
    lines.push("");
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
