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
  const intervalHandles = [];
  let contextStopped = false;
  let stopObservers = () => {};
  const stopForInvalidContext = () => {
    if (contextStopped) return;
    contextStopped = true;
    intervalHandles.splice(0).forEach((handle) => clearInterval(handle));
    stopObservers();
  };
  const scheduleInterval = (task, delay) => {
    if (contextStopped || !core.isExtensionContextValid()) {
      stopForInvalidContext();
      return;
    }
    intervalHandles.push(setInterval(task, delay));
  };
  const runIntervalTask = (task, onError = () => {}) => {
    if (!core.isExtensionContextValid()) {
      stopForInvalidContext();
      return;
    }
    Promise.resolve()
      .then(task)
      .then(() => {
        if (!core.isExtensionContextValid()) stopForInvalidContext();
      })
      .catch((error) => {
        if (!core.isExtensionContextValid()) {
          stopForInvalidContext();
        } else {
          try {
            onError(error);
          } catch {
            stopForInvalidContext();
          }
        }
      });
  };

  if (isAppHost) {
    ensureRoot();
    core.checkForUpdate().catch(() => {});
    core.refreshBalanceDisplay();
    scheduleInterval(
      () => runIntervalTask(() => core.checkForUpdate()),
      core.UPDATE_CHECK_INTERVAL_MS
    );
    scheduleInterval(() => runIntervalTask(() => core.refreshBalanceDisplay()), 30000);
    // Devin is an SPA that may swap out the body; keep the React root attached.
    let ensureRootScheduled = false;
    let observedBody = null;
    let ensureRootTimer = null;
    let ensureRootTimerType = "";
    const bodyObserver = new MutationObserver(scheduleEnsureRoot);
    const documentObserver = new MutationObserver(scheduleEnsureRoot);
    const observeBody = () => {
      if (contextStopped) return;
      if (document.body && document.body !== observedBody) {
        bodyObserver.disconnect();
        observedBody = document.body;
        bodyObserver.observe(observedBody, { childList: true });
      }
    };
    const runEnsureRoot = () => {
      ensureRootTimer = null;
      ensureRootTimerType = "";
      ensureRootScheduled = false;
      if (contextStopped || !core.isExtensionContextValid()) {
        stopForInvalidContext();
        return;
      }
      ensureRoot();
      observeBody();
    };
    function scheduleEnsureRoot() {
      if (contextStopped || !core.isExtensionContextValid()) {
        stopForInvalidContext();
        return;
      }
      if (ensureRootScheduled) {
        return;
      }
      ensureRootScheduled = true;
      if (typeof requestAnimationFrame === "function") {
        ensureRootTimerType = "animationFrame";
        ensureRootTimer = requestAnimationFrame(runEnsureRoot);
      } else {
        ensureRootTimerType = "timeout";
        ensureRootTimer = setTimeout(runEnsureRoot, 0);
      }
    }
    documentObserver.observe(document.documentElement, { childList: true });
    observeBody();
    stopObservers = () => {
      bodyObserver.disconnect();
      documentObserver.disconnect();
      if (ensureRootTimer !== null) {
        if (ensureRootTimerType === "animationFrame" && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(ensureRootTimer);
        } else {
          clearTimeout(ensureRootTimer);
        }
        ensureRootTimer = null;
        ensureRootTimerType = "";
      }
    };
    if (contextStopped) stopObservers();
  }
  runIntervalTask(() => core.runAutoSwitch(), (error) =>
    core.setToolbarStatus(error.message, true)
  );
  scheduleInterval(
    () =>
      runIntervalTask(() => core.runAutoSwitch(), (error) =>
        core.setToolbarStatus(error.message, true)
      ),
    1500
  );
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
