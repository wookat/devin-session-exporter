# Devin Session Exporter

## English

This is a small Manifest V3 browser extension for exporting the conversation,
worklog, and file changes
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

### Export sections and formats

- **Conversation**: user and Devin messages.
- **Worklog**: Devin thoughts, commands, file reads/edits, searches, todos, and
  status updates.
- **Changes**: local-repository file diffs when available.
- **Markdown**: readable sections with fenced command and diff blocks.
- **JSON**: pretty-printed structured data.
- **Plain text**: readable labeled equivalents.

The extension retrieves session metadata and paginated conversation events. By
default, internal Devin thoughts are excluded; enable **Include Devin's
thoughts** when those conversation events should be included. Worklog and
Changes are optional sections in the popup. Changes reflect local-repository
edits and may be empty for sessions that only used remote SSH work.

### Automatic account rotation

The in-page toolbar also supports manual **换到下一个号** and optional
automatic rotation when a genuine usage-quota or credit-exhaustion message is
visible. Configure the ordered account list, enable **启用自动换号**, and
choose whether to **自动发送续接**. The flow exports the current Handoff,
logs out through the account menu, signs into the next configured
email/password account, creates a new session, and fills or sends the
continuation prompt.

Account passwords are stored locally by the extension when account rotation is
configured. This feature can expose credentials to local browser storage and
may violate Devin's terms or result in account bans; use it only for accounts
you control. It supports email/password accounts without 2FA. The optional
master-password setting encrypts the account list with Web Crypto and caches
the passphrase only for the current browser session.

The in-page toolbar displays the current account's on-demand remaining balance
and per-message usage limit when Devin's billing API is available. The account
settings include a configurable **Message usage limit** target, defaulting to
200 dollars. The target is applied automatically after each account switch and
can also be applied manually to the current account. This calls Devin's own
billing settings endpoint; failures do not stop the continuation flow.

The toolbar balance refreshes every 30 seconds and shows overage balance,
available credits, and the per-message limit. The settings panel supports
batch account entry, one account per line. Besides `email---password---ignored`
(three or more dashes), the parser also accepts `email:password`,
tab/pipe/comma/space separated pairs, one JSON object per line
(`{"email":..., "password":...}`), and a whole-textarea JSON array. Each saved
account has a **查余额** action, and **刷新全部余额** checks all configured
password accounts sequentially without switching the current Devin login.

### Per-account sessions without switching

Each saved account has a **会话** action that uses the account's email/password
to obtain a temporary token in the background and lists that account's sessions
(`GET /api/{org}/v2sessions`) with a search box — all without switching the
currently logged-in Devin account. For any listed session you can:

- **导出Handoff**: fetch the session events with the temporary token and
  download an AI-oriented Handoff Markdown, without switching accounts.

The AI-oriented Handoff is optimized for a receiving session, not for humans:

- A **TL;DR (先读这里)** block at the top carries the objective, todo progress,
  and the concrete next steps, so a new session reaches the actionable state
  immediately.
- The verbose **Full conversation** transcript is **off by default** (the
  injected/continuation Handoff no longer duplicates the whole conversation);
  the manual **导出 Handoff** download still includes it.
- Long pasted noise (token-scope dumps, logs, nested prior Handoffs) is
  collapsed/truncated, and repeated cluster instructions are de-duplicated.
- Attachment links (`app.devin.ai/attachments/...`) are auth-gated and useless
  to another account, so they are not passed through as bare links. Text/Markdown
  attachments are fetched with the current auth and **inlined** into the Handoff;
  images/binaries become a one-line note (`[附件已省略：name · size]`).
- **打开(不换号)**: open the session in a new tab rendered as that account.
  This works via `vauth.js`, a MAIN-world script that runs before page scripts
  on `app.devin.ai/sessions/*` and virtualizes only that tab's `localStorage`
  with the target account's token (passed transiently through the URL hash and
  immediately stripped). The real `localStorage` is never written, so other
  tabs keep the current account. This relies on Devin's token-based auth and
  requires a Chromium MAIN-world content script; it only works for
  email/password accounts without 2FA.

## 简体中文

这是一个简单的 Manifest V3 浏览器扩展，用于导出当前打开的
`https://app.devin.ai/sessions/*` Devin 会话记录，包括对话、工作日志和文件变更。

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

### 导出内容和格式

- **Conversation（对话）**：用户和 Devin 的消息。
- **Worklog（工作日志）**：Devin 的思考、命令、文件读取/编辑、搜索、
  待办事项和状态更新。
- **Changes（变更）**：可用时导出本地仓库的文件差异。
- **Markdown**：包含可读章节，以及命令和差异的代码块。
- **JSON**：格式化后的结构化数据。
- **纯文本**：易读的带标签文本。

扩展会读取会话元数据和分页后的对话事件。默认不包含 Devin 的内部思考；
如果需要在对话中导出这些内容，可以勾选 **Include Devin's thoughts**。
Worklog 和 Changes 可以在弹窗中单独选择。Changes 反映本地仓库编辑；
如果会话只使用了远程 SSH，Changes 可能为空。

### 自动换号

页面内工具栏还支持手动 **换到下一个号**，以及在检测到真实用量配额或
免费额度耗尽提示时启用自动换号。请在设置中维护有顺序的账号列表，开启
**启用自动换号**，并选择是否**自动发送续接**。流程会导出当前 Handoff，
通过账号菜单退出，登录下一个配置的邮箱密码账号，创建新会话，然后填入或
发送续接提示。

配置自动换号后，账号密码会保存在扩展的本地存储中。这可能带来本地凭据
暴露风险，也可能违反 Devin 服务条款或导致账号封禁；只应对自己控制的账号
使用。当前支持无 2FA 的邮箱密码账号。可选的主密码设置使用 Web Crypto
加密账号列表，并且只在当前浏览器会话中缓存密码短语。

页面内工具栏会在 Devin 计费接口可用时显示当前账号的按需剩余额度和单条
消息用量上限。设置中的**每个账号消息用量上限**默认为 200 美元，可配置；
每次自动换号登录后会自动应用，也可以点击按钮手动应用到当前账号。该功能
调用 Devin 自己的计费设置接口；如果失败，不会中断续接流程。

工具栏余额每 30 秒刷新一次，显示超额余额、可用额度与单条消息上限。设置面板
支持批量添加账号，每行一条。除 `邮箱---密码---可忽略字段`（三个及以上短横线）
外，还支持 `邮箱:密码`、以制表符/竖线/逗号/空格分隔的成对格式、每行一个 JSON
对象（`{"email":..., "password":...}`），以及整个文本框为一个 JSON 数组。每个
账号还有**查余额**按钮，**刷新全部余额**会按顺序查询所有已配置的邮箱密码账号，
不会切换当前 Devin 登录账号。

### 不换号查看/打开其他账号的会话

每个已保存账号都有**会话**按钮：后台用该账号邮箱密码换取临时令牌，列出该账号
的会话列表（`GET /api/{org}/v2sessions`）并可搜索，全程不切换当前登录账号。
对列表里的任意会话可以：

- **导出Handoff**：用临时令牌拉取该会话事件，下载面向 AI 续接的 Handoff
  Markdown，无需切号。

面向 AI 续接的 Handoff 针对「新会话读取」而非「人类阅读」做了优化：

- 顶部 **TL;DR（先读这里）**：目标、TODO 进度、明确的下一步，让新会话立刻进入
  可执行状态。
- 冗长的 **Full conversation** 全文附录**默认关闭**（注入/续接用的 Handoff 不再
  把整段对话重复一遍）；手动点 **导出 Handoff** 下载的文件仍包含全文。
- 折叠/截断超长粘贴噪音（token scope 清单、日志、嵌套的上一份 Handoff），并对
  重复的集群接入说明去重。
- 附件链接（`app.devin.ai/attachments/...`）需要鉴权、对其他账号无用，因此不再
  原样塞链接：文本/Markdown 附件会用当前登录态抓取并**内联**进 Handoff；图片/
  二进制改成一行说明（`[附件已省略：名称 · 大小]`）。
- **打开(不换号)**：在新标签页以该账号身份渲染并打开会话。原理是 `vauth.js`——
  一个在 `app.devin.ai/sessions/*` 页面脚本之前运行的 MAIN world 脚本，只把
  该标签页的 `localStorage` 虚拟化为目标账号的令牌（令牌经 URL 锚点瞬时传入
  并立即清除），真实 `localStorage` 不被写入，其他标签页仍是当前账号。该能力
  依赖 Devin 的纯令牌鉴权，需要 Chromium 的 MAIN world 内容脚本，且仅对无 2FA
  的邮箱密码账号有效。
