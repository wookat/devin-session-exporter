# Devin Session Exporter

## English

This is a small Manifest V3 browser extension for exporting the conversation
from the Devin session currently open at
`https://app.devin.ai/sessions/*`.

The extension runs in the logged-in `app.devin.ai` tab and calls Devin's
same-origin session and events endpoints using the browser's existing session
token. It does not embed a Devin API key or service-user token. Only the
currently opened session is exported.

### Load unpacked in Chrome or Edge

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository directory.
5. Open a Devin session, click the extension icon, choose a format, and click
   **Export**.

Firefox can load the extension from `about:debugging` → **This Firefox** →
**Load Temporary Add-on**, subject to Firefox's Manifest V3 compatibility.

### Formats

- **Markdown**: title, session URL, export time, and one section per message.
- **JSON**: pretty-printed structured data.
- **Plain text**: a readable title and labeled message transcript.

The extension retrieves session metadata and paginated conversation events. By
default, internal Devin thoughts are excluded; enable **Include Devin's
thoughts** when those events should be included.

## 简体中文

这是一个简单的 Manifest V3 浏览器扩展，用于导出当前打开的
`https://app.devin.ai/sessions/*` Devin 会话记录。

扩展在已经登录的 `app.devin.ai` 页面中调用 Devin 的同源会话和事件接口，
使用浏览器已有的登录令牌，不嵌入 Devin API 密钥或服务用户令牌。
扩展只导出当前打开的会话。

### 在 Chrome 或 Edge 中加载

1. 打开 `chrome://extensions`（或 `edge://extensions`）。
2. 开启右上角的**开发者模式**。
3. 点击**加载已解压的扩展程序**。
4. 选择本仓库目录。
5. 打开 Devin 会话，点击扩展图标，选择格式，然后点击**导出**。

Firefox 可以通过 `about:debugging` → **此 Firefox** → **临时载入附加组件**
加载，但具体支持情况取决于 Firefox 对 Manifest V3 的兼容性。

### 导出格式

- **Markdown**：包含标题、会话 URL、导出时间以及每条消息的独立章节。
- **JSON**：格式化后的结构化数据。
- **纯文本**：易读的标题和带角色标记的消息记录。

扩展会读取会话元数据和分页后的对话事件。默认不包含 Devin 的内部思考；
如果需要导出这些内容，可以勾选 **Include Devin's thoughts**。
