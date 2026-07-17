import React, {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore
} from "react";
import * as core from "../core.js";

function useStore() {
  return useSyncExternalStore(core.subscribe, core.getRevision, core.getRevision);
}

function downloadText(filename, text) {
  const link = document.createElement("a");
  link.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;
  link.download = filename;
  link.click();
}

function reportError(error) {
  core.setToolbarStatus(error?.message || String(error) || "操作失败", true);
}

function Toolbar({ onToggleSettings }) {
  useStore();
  const [busy, setBusy] = useState(false);
  const status = core.getStatus();
  const balanceInfo = core.getCurrentBalanceInfo();
  const onSession = core.isSessionPage();

  const exportHandoff = useCallback(async () => {
    setBusy(true);
    try {
      const { data, compact, full } = await core.exportHandoff();
      downloadText(`devin-handoff-${core.fileDateStamp()}.md`, full || compact);
      core.setToolbarStatus(`已保存：${data.title || "Handoff"}`);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div id="devin-exporter-toolbar">
      <button
        id="devin-export-handoff"
        type="button"
        className={busy ? "is-loading" : ""}
        disabled={!onSession || busy}
        onClick={exportHandoff}
      >
        导出 Handoff
      </button>
      <button id="devin-settings-button" type="button" onClick={onToggleSettings}>
        设置
      </button>
      <span id="devin-exporter-balance" className={balanceInfo ? core.balanceToneClass(balanceInfo) : ""}>
        {balanceInfo ? core.formatBalanceOnly(balanceInfo) : "余额 —"}
      </span>
      <span id="devin-exporter-status" role="status" data-error={status.isError ? "true" : "false"}>
        {status.message}
      </span>
    </div>
  );
}

function CurrentAccountCard() {
  useStore();
  const email = core.getCurrentEmail();
  const info = core.getCurrentBalanceInfo();
  return (
    <div id="devin-current-account" className="devin-current">
      <div className="devin-current-line">
        <span className="devin-current-email">{email || "未登录"}</span>
        <button
          type="button"
          className="devin-icon-btn"
          title="刷新"
          onClick={() => {
            core.refreshCurrentAccount().catch(reportError);
            core.refreshBalanceDisplay();
          }}
        >
          ↻
        </button>
      </div>
      <div className={`devin-current-meta ${info ? core.balanceToneClass(info) : ""}`}>
        {info ? core.formatBalanceDisplay(info) : "余额 — · 上限 —"}
      </div>
      <div className="devin-current-actions">
        <button type="button" onClick={() => core.beginAutoSwitch(true).catch(reportError)}>
          换到下一个号
        </button>
      </div>
    </div>
  );
}

function AccountSessions({ account, sessionKey }) {
  useStore();
  const state = core.getSessionsState(sessionKey);
  if (!state || !state.expanded) return null;
  if (state.loading) return <div className="devin-account-sessions">正在读取会话列表…</div>;
  if (state.error) {
    return <div className="devin-account-sessions devin-account-balance-error">{state.error}</div>;
  }
  const needle = String(state.filter || "").trim().toLowerCase();
  const filtered = state.sessions.filter((session) =>
    !needle || `${session.title} ${session.sessionId}`.toLowerCase().includes(needle)
  );
  return (
    <div className="devin-account-sessions">
      <input
        type="search"
        className="devin-session-filter"
        placeholder={`搜索 ${state.sessions.length} 个会话…`}
        value={state.filter || ""}
        onChange={(event) => core.setSessionFilter(sessionKey, event.target.value)}
      />
      <div className="devin-session-list">
        {filtered.length === 0 ? (
          <div className="devin-session-empty">
            {state.sessions.length ? "没有匹配的会话" : "该账号没有会话"}
          </div>
        ) : (
          filtered.slice(0, 100).map((session) => (
            <div className="devin-session-row" key={session.sessionId}>
              <span className="devin-session-title" title={session.title}>
                {session.status ? `${session.title} · ${session.status}` : session.title}
              </span>
              <button type="button" onClick={() => core.openIsolatedSession(session, state.auth)}>
                打开(不换号)
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const text = await core.exportSessionHandoff(session, state.auth);
                    downloadText(
                      `devin-handoff-${session.sessionId.slice(0, 12)}-${core.fileDateStamp()}.md`,
                      text
                    );
                  } catch (error) {
                    reportError(error);
                  }
                }}
              >
                导出Handoff
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function AccountRow({ account, index, total, onEdit }) {
  const key = core.accountKey(account);
  const balanceInfo = core.getBalanceInfo(key);
  const latest = core.getLatestInfo(key);
  const sessionsState = core.getSessionsState(key);
  const selected = core.isAccountSelected(key);
  const hasLatest = latest && latest.session && latest.session.sessionId;
  return (
    <div className={account.archived ? "devin-account-row devin-account-archived" : "devin-account-row"}>
      <div className="devin-account-main">
        <input
          type="checkbox"
          className="devin-account-select"
          checked={selected}
          onChange={() => core.toggleAccountSelect(key)}
        />
        <div className="devin-account-identity">
          <strong title={account.email}>{`${index + 1}. ${account.label || account.email}`}</strong>
          {account.archived ? <span className="devin-account-badge">已归档</span> : null}
          {account.label && account.label !== account.email ? <span>{account.email}</span> : null}
        </div>
        <span className={`devin-account-balance ${core.accountBalanceClass(balanceInfo)}`}>
          {core.formatAccountBalance(balanceInfo)}
        </span>
      </div>
      <div className="devin-account-meta">
        {hasLatest ? (
          <>
            <span className="devin-account-meta-label">最新会话：</span>
            <a
              href="#"
              className="devin-account-latest-link"
              title={latest.session.title || "点击打开该会话（不换号）"}
              onClick={(event) => {
                event.preventDefault();
                core.openLatestSession(account, latest.session).catch(reportError);
              }}
            >
              {latest.session.title || latest.session.sessionId}
            </a>
            <span className="devin-account-status">
              {`${core.sessionStatusIcon(latest.session.status)} ${core.formatSessionStatus(latest.session.status)}`}
            </span>
          </>
        ) : (
          core.formatLatestSession(latest)
        )}
      </div>
      <div className="devin-account-actions">
        <button
          type="button"
          className="devin-account-switch"
          onClick={() => core.beginSwitchToAccount(account.email).catch(reportError)}
        >
          切到此号
        </button>
        <button
          type="button"
          className="devin-account-action-icon"
          title="刷新账号信息"
          aria-label="刷新账号信息"
          onClick={() => core.refreshAccountMeta(account).catch(reportError)}
        >
          ↻
        </button>
        <button
          type="button"
          className="devin-account-action-icon"
          title={sessionsState?.expanded ? "收起会话" : "查看会话"}
          aria-label={sessionsState?.expanded ? "收起会话" : "查看会话"}
          onClick={() => core.toggleAccountSessions(account).catch(reportError)}
        >
          ▤
        </button>
        <button
          type="button"
          className="devin-account-action-icon"
          title="编辑账号"
          aria-label="编辑账号"
          onClick={() => {
            onEdit(core.accountEditText(account));
            core.setToolbarStatus("已填入文本框，修改后点「添加账号」按相同邮箱更新");
          }}
        >
          ✎
        </button>
        <button
          type="button"
          className="devin-account-action-icon"
          title={account.archived ? "取消归档" : "归档账号"}
          aria-label={account.archived ? "取消归档" : "归档账号"}
          onClick={() => core.toggleAccountArchive(index).catch(reportError)}
        >
          ▣
        </button>
        <button
          type="button"
          className="devin-account-action-icon"
          title="删除账号"
          aria-label="删除账号"
          onClick={() => core.deleteAccount(key).catch(reportError)}
        >
          🗑
        </button>
        <button
          type="button"
          className="devin-account-action-icon"
          title="上移账号"
          aria-label="上移账号"
          disabled={index === 0}
          onClick={() => core.moveAccount(index, -1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="devin-account-action-icon"
          title="下移账号"
          aria-label="下移账号"
          disabled={index === total - 1}
          onClick={() => core.moveAccount(index, 1)}
        >
          ↓
        </button>
      </div>
      <AccountSessions account={account} sessionKey={key} />
    </div>
  );
}

function AccountList({ onEdit }) {
  useStore();
  const accounts = core.getAccounts();
  const total = accounts.length;
  const selectedCount = core.getSelectedCount();
  if (!total) {
    return (
      <div id="devin-account-list">
        <div className="devin-account-empty">还没有账号，在下方文本框添加。</div>
      </div>
    );
  }
  return (
    <div id="devin-account-list">
      <div className="devin-account-batchbar">
        <label className="devin-batch-selectall">
          <input
            type="checkbox"
            checked={total > 0 && selectedCount === total}
            ref={(el) => {
              if (el) el.indeterminate = selectedCount > 0 && selectedCount < total;
            }}
            onChange={(event) => core.setAllAccountsSelected(event.target.checked)}
          />
          <span>{selectedCount ? `已选 ${selectedCount}/${total}` : `共 ${total} 个账号`}</span>
        </label>
        <button
          type="button"
          onClick={() => core.refreshAccountsBalances(selectedCount > 0).catch(reportError)}
        >
          {selectedCount ? "刷新选中余额" : "刷新全部余额"}
        </button>
        <button
          type="button"
          disabled={!selectedCount}
          onClick={() => core.deleteSelectedAccounts().catch(reportError)}
        >
          删除选中
        </button>
      </div>
      {accounts.map((account, index) => (
        <AccountRow
          key={core.accountKey(account) || index}
          account={account}
          index={index}
          total={total}
          onEdit={onEdit}
        />
      ))}
    </div>
  );
}

function PromptSnippets() {
  useStore();
  const snippets = core.getSnippets();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  return (
    <details className="devin-details">
      <summary>提示词快捷剪贴板</summary>
      <div id="devin-snippet-list">
        {snippets.length === 0 ? (
          <div className="devin-account-empty">还没有提示词，在下方添加。</div>
        ) : (
          snippets.map((snippet, index) => (
            <div className="devin-snippet-row" key={index}>
              <span className="devin-snippet-title" title={snippet.text}>
                {snippet.title || snippet.text.slice(0, 24)}
              </span>
              <button type="button" onClick={() => core.copySnippetToClipboard(snippet.text)}>
                复制
              </button>
              <button type="button" onClick={() => core.removePromptSnippet(index).catch(reportError)}>
                删除
              </button>
            </div>
          ))
        )}
      </div>
      <input
        id="devin-snippet-title"
        type="text"
        placeholder="标题（如：安装 skill / 连接仓库 / 连远程）"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        id="devin-snippet-text"
        placeholder="提示词内容，保存后可一键复制"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="devin-settings-actions">
        <button
          type="button"
          onClick={async () => {
            const ok = await core.addPromptSnippet(title, text);
            if (ok) {
              setTitle("");
              setText("");
            }
          }}
        >
          添加提示词
        </button>
      </div>
    </details>
  );
}

function SettingsPanel({ onClose }) {
  useStore();
  const [settings, setSettings] = useState(null);
  const [template, setTemplate] = useState(core.DEFAULT_HANDOFF_TEMPLATE);
  const [batchText, setBatchText] = useState("");

  useEffect(() => {
    core
      .loadSettingsState()
      .then((state) => {
        setSettings(state.settings);
        setTemplate(state.template);
      })
      .catch(reportError);
  }, []);

  const patch = (key, value) => setSettings((prev) => ({ ...prev, [key]: value }));

  if (!settings) {
    return (
      <div id="devin-exporter-settings">
        <div className="devin-settings-header">
          <h2>Devin Exporter</h2>
          <button type="button" className="devin-close-x" title="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <p>正在加载…</p>
      </div>
    );
  }

  const saveAll = async () => {
    try {
      await core.saveSettings({ ...settings, continuationTemplate: template });
      onClose();
    } catch (error) {
      reportError(error);
    }
  };

  return (
    <div id="devin-exporter-settings">
      <div className="devin-settings-header">
        <h2>Devin Exporter</h2>
        <button type="button" className="devin-close-x" title="关闭" onClick={onClose}>
          ×
        </button>
      </div>

      {core.getUpdateVersion() ? (
        <div className="devin-update-notice">
          {`有新版 v${core.getUpdateVersion()}：双击 update-unpacked-windows.cmd 后重启 Chrome 即可更新。`}
        </div>
      ) : null}

      <CurrentAccountCard />

      <section className="devin-settings-section">
        <div className="devin-field-row">
          <label className="devin-field">
            用量上限
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="200"
              value={settings.targetUsageLimit}
              onChange={(event) => patch("targetUsageLimit", event.target.value)}
            />
          </label>
          <label className="devin-field">
            最低可切余额
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="65"
              value={settings.switchMinBalance}
              onChange={(event) => patch("switchMinBalance", event.target.value)}
            />
          </label>
        </div>
        <div className="devin-toggle-row">
          <label>
            <input
              type="checkbox"
              checked={settings.autoSwitchEnabled}
              onChange={(event) => patch("autoSwitchEnabled", event.target.checked)}
            />{" "}
            自动换号
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.autoSendContinuation}
              onChange={(event) => patch("autoSendContinuation", event.target.checked)}
            />{" "}
            自动发送续接
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.encryptionEnabled}
              onChange={(event) => {
                patch("encryptionEnabled", event.target.checked);
                core.setEncryptionEnabled(event.target.checked);
              }}
            />{" "}
            加密账号
          </label>
        </div>
        <div className="devin-settings-actions">
          <button
            type="button"
            onClick={() => core.applyTargetUsageLimit(settings.targetUsageLimit)}
          >
            应用上限
          </button>
          <button type="button" className="devin-primary" onClick={saveAll}>
            保存设置
          </button>
        </div>
        <details className="devin-details">
          <summary>续接模板（固定：交出上下文，接手继续）</summary>
          <textarea
            placeholder="续接模板"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
          />
          <div className="devin-settings-actions">
            <button type="button" onClick={() => setTemplate(core.DEFAULT_HANDOFF_TEMPLATE)}>
              恢复默认模板
            </button>
          </div>
        </details>
        <PromptSnippets />
      </section>

      <section className="devin-settings-section">
        <h3>已保存账号</h3>
        <AccountList onEdit={setBatchText} />
        <textarea
          id="devin-batch-accounts"
          placeholder="每行一个账号：邮箱---密码（第三段及以后忽略）"
          value={batchText}
          onChange={(event) => setBatchText(event.target.value)}
        />
        <div className="devin-settings-actions">
          <button
            type="button"
            onClick={async () => {
              const ok = await core.addBatchAccounts(batchText);
              if (ok) setBatchText("");
            }}
          >
            添加账号
          </button>
        </div>
      </section>
    </div>
  );
}

export function App() {
  const [panelOpen, setPanelOpen] = useState(false);
  return (
    <>
      <Toolbar onToggleSettings={() => setPanelOpen((open) => !open)} />
      {panelOpen ? <SettingsPanel onClose={() => setPanelOpen(false)} /> : null}
    </>
  );
}
