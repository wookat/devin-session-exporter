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

### One-click install for all Chrome profiles (Windows)

Instead of loading it unpacked in every profile, `install/install-windows.ps1`
installs the extension for **all Chrome profiles on the machine** via Chrome's
enterprise policy (self-hosted, force-installed) and Chrome then **auto-updates**
it from the GitHub release — no manual reinstall on new versions.

1. Download `install/install-windows.cmd` from this repo.
2. **Double-click it** (it self-elevates and prompts for administrator).
3. Fully restart Chrome (close all windows). The extension appears in every
   profile, fixed extension ID `mdahidnfandbmeaoegfkiajhjaoehldl`.

To remove it, double-click `install/uninstall-windows.cmd` and restart Chrome.

(PowerShell equivalents `install/install-windows.ps1` /
`install-windows-user.ps1` — the latter is a no-admin `HKCU` variant — are also
available.)

> **Note:** Chrome only force-installs *Web Store* extensions via local policy.
> A self-hosted extension is blocked (`[BLOCKED]` in `chrome://policy`) unless the
> machine is enterprise-managed (domain-joined or Chrome Browser Cloud
> Management). On a personal machine, use the load-unpacked method below instead.

### Load-unpacked install (no store, no admin, personal machines)

`install/load-unpacked-windows.cmd` downloads the latest extension to a fixed
folder (`%USERPROFILE%\Downloads\DevinSessionExporter`) and opens `chrome://extensions`.
Once per profile: turn on **Developer mode** → **Load unpacked** → pick that
folder. To update later, run `install/update-unpacked-windows.cmd` and restart
Chrome — no need to re-add it.

**How updates work.** Pushing a commit to `main` with a bumped `version` in
`manifest.json` triggers `.github/workflows/release-extension.yml`, which packs a
signed CRX (using the `EXTENSION_CRX_KEY` repo secret) and publishes it plus an
`updates.xml` as a GitHub release `ext-v<version>`. The installed policy points at
`releases/latest/download/updates.xml`, so every machine picks up the new version
automatically in the background. Bump the manifest version on each functional
change, otherwise the release tag is reused and clients keep the old build.

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

When an account is added (single or batch), the extension **immediately** signs
it in in the background, sets its **usage limit to the target (default 200
dollars)**, and queries its balance — so you see the balance right away without
switching or clicking **查余额**. Rotation reuses these cached balances.

Rotation only switches to accounts whose balance is **above a configurable
floor (default 65 dollars)**; accounts at or below the floor are treated as
exhausted and skipped. If no account is above the floor, rotation stops with a
message instead of switching to a dead account. Both the usage-limit target and
the switch floor are set in the **余额与切号** section of the settings panel.

The balance shown is Devin's **remaining balance** (`billing_status.overage_credits`,
which can be negative once exhausted); `available_credits` is intentionally not
used because it is often 0 on pay-as-you-go accounts. Queried balances are
persisted locally, so opening the settings panel shows the last known balances
immediately and refreshes only stale ones (older than 5 minutes) in the
background; a failed refresh keeps the last good value instead of blanking it.

The toolbar balance chip shows only the account's remaining balance
(`余额 $X`) and refreshes every 30 seconds; the per-message limit is shown in
the settings panel's current-account header. Exporting a Handoff
shows a spinner on the button while it runs, and exported files are named with a
human-readable date, e.g. `devin-handoff-2026-07-17_16-30.md`. The settings panel supports
batch account entry, one account per line. Besides `email---password---ignored`
(three or more dashes), the parser also accepts `email:password`,
tab/pipe/comma/space separated pairs, one JSON object per line
(`{"email":..., "password":...}`), and a whole-textarea JSON array.

Accounts are shown as a compact list with per-row checkboxes. A batch bar on top
provides **select-all**, **刷新全部余额 / 刷新选中余额** (one-click refresh of all
or the selected accounts) and **删除选中** (bulk delete). Each row shows the
account's balance and its **latest session and status** (e.g. `正在运行`),
fetched in the background and persisted so it appears without expanding. Per-row
actions are **刷新** (re-query balance + latest session), **会话** (list sessions),
**编辑** (refill the textarea to update by email) and **删除**. Account switching
(**换到下一个号**) lives in the settings panel's **余额与切号** section, since it
is a low-frequency action; the floating toolbar keeps only the high-frequency
**导出 Handoff** and **设置** (which toggles the panel open/closed).

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

### 一键安装到所有 Chrome 配置文件（Windows）

不用在每个 profile 里手动「加载已解压」，`install/install-windows.ps1` 会用
Chrome 企业策略（自托管、强制安装）把插件装到**本机所有 Chrome 配置文件**，
之后 Chrome 会从 GitHub Release **自动更新**，发新版无需手动重装。

1. 从仓库下载 `install/install-windows.cmd`。
2. **双击运行**（会自动请求管理员授权）。
3. 完全重启 Chrome（关闭所有窗口）。插件会出现在每个 profile 里，固定扩展 ID
   `mdahidnfandbmeaoegfkiajhjaoehldl`。

卸载：双击 `install/uninstall-windows.cmd` 后重启 Chrome。

（也提供 PowerShell 版 `install/install-windows.ps1`，以及免管理员的 `HKCU` 版
`install-windows-user.ps1`。）

> **注意**：Chrome 只允许通过本机策略强制安装**应用商店**里的扩展；自托管扩展会被
> 拦截（`chrome://policy` 里显示 `[BLOCKED]`），除非机器被企业纳管（加域 / Chrome
> 云管理）。个人电脑请改用下面的「加载已解压」方式。

### 加载已解压安装（不走商店、免管理员、适合个人电脑）

`install/load-unpacked-windows.cmd` 会把最新插件下载到固定目录
（`%USERPROFILE%\Downloads\DevinSessionExporter`，即系统「下载」目录）并打开 `chrome://extensions`。每个 profile
点一次：打开**开发者模式** →「加载已解压」→ 选该目录。之后更新只需运行
`install/update-unpacked-windows.cmd` 再重启 Chrome，无需重新添加。

**更新机制**：向 `main` 推送并把 `manifest.json` 里的 `version` 提升，会触发
`.github/workflows/release-extension.yml`，用仓库密钥 `EXTENSION_CRX_KEY` 打包
签名 CRX，并把它和 `updates.xml` 一起发布为 Release `ext-v<version>`。已安装的
策略指向 `releases/latest/download/updates.xml`，所有机器后台自动升级。**每次功能
改动都要提升 manifest 版本号**，否则会复用旧 tag，客户端拿不到新版本。

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

添加账号时（单个或批量），扩展会**立即**在后台登录该号，把它的**用量上限设为
目标值（默认 200 美元）**并查询余额——无需切号、也无需手动点**查余额**即可看到
结果，换号时直接复用这些缓存余额。

自动换号只会切到**余额高于阈值（默认 65 美元）**的账号；余额不高于阈值的视为
已耗尽并跳过；若没有任何账号高于阈值，则不切号并给出提示，避免切到没额度的
死号。用量上限目标与切号最低余额都在设置面板的 **余额与切号** 区块配置。

显示的余额是 Devin 的**剩余余额**（`billing_status.overage_credits`，耗尽后可为
负数）；不使用 `available_credits`，因为按量付费账号该值常为 0。已查询的余额会
本地持久化：打开设置面板即显示上次已知余额，只在后台刷新过期项（超过 5 分钟），
刷新失败时保留上次的正常值而不是清空。

工具栏余额条显示账号剩余余额与单条消息上限（`余额 $X · 上限 $Y`），每 30 秒
刷新。导出 Handoff 时按钮上会显示旋转图标，导出的文件名使用人类可读日期，例如
`devin-handoff-2026-07-17_16-30.md`。设置面板支持批量添加账号，每行一条。除 `邮箱---密码---可忽略字段`（三个及以上短横线）
外，还支持 `邮箱:密码`、以制表符/竖线/逗号/空格分隔的成对格式、每行一个 JSON
对象（`{"email":..., "password":...}`），以及整个文本框为一个 JSON 数组。

账号以紧凑**列表**呈现，每行带勾选框；顶部批量操作栏提供**全选**、**刷新全部
余额 / 刷新选中余额**（一键刷新全部或所选账号）与**删除选中**（批量删除）。每
行显示该账号余额，以及后台获取并持久化的**最新一条会话及其状态**（如「正在运行」），
无需展开即可看到。每行操作有**刷新**（重新查询余额+最新会话）、**会话**（列出
会话）、**编辑**（回填文本框按邮箱更新）、**删除**。**换到下一个号**属于低频操作，
已移入设置面板的 **余额与切号** 区块；悬浮工具栏只保留高频的 **导出 Handoff** 与
**设置**（再次点击「设置」即可关闭面板）。

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
