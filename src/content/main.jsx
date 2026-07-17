import React from "react";
import { createRoot } from "react-dom/client";
import * as core from "../core.js";
import { App } from "./App.jsx";
import "./ui.css";

const ROOT_ID = "devin-exporter-root";

function ensureRoot() {
  let container = document.getElementById(ROOT_ID);
  if (!container) {
    container = document.createElement("div");
    container.id = ROOT_ID;
    document.body.appendChild(container);
    createRoot(container).render(<App />);
  } else if (!container.isConnected) {
    document.body.appendChild(container);
  }
}

const isAppHost = typeof location !== "undefined" && location.hostname === "app.devin.ai";
const isAutoSwitchHost =
  isAppHost || (typeof location !== "undefined" && location.hostname === "devin.ai");

if (typeof document !== "undefined" && isAutoSwitchHost) {
  if (isAppHost) {
    ensureRoot();
    core.checkForUpdate().catch(() => {});
    core.refreshBalanceDisplay();
    setInterval(() => core.checkForUpdate().catch(() => {}), core.UPDATE_CHECK_INTERVAL_MS);
    setInterval(() => core.refreshBalanceDisplay(), 30000);
    // Devin is an SPA that may swap out the body; keep the React root attached.
    new MutationObserver(() => ensureRoot()).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }
  core.runAutoSwitch().catch((error) => core.setToolbarStatus(error.message, true));
  setInterval(() => {
    core.runAutoSwitch().catch((error) => core.setToolbarStatus(error.message, true));
  }, 1500);
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "extractConversation") {
      return false;
    }
    core
      .extractConversation(message.options)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) =>
        sendResponse({ ok: false, error: error.message || "Conversation extraction failed" })
      );
    return true;
  });
}
