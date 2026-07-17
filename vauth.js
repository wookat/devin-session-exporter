// MAIN-world script (runs before page scripts at document_start).
//
// When a Devin session tab is opened with a `#daoauth=<base64-json>` marker,
// this virtualizes that single tab's localStorage so the Devin SPA renders as
// the target account without changing the real logged-in account. The real
// localStorage is never written: the tab reads/writes an in-memory store that
// is seeded with the target account's auth token and known organization ids.
// Other tabs keep using the real account. The marker is removed from the URL
// immediately so the token is not left visible.
(function () {
  "use strict";
  try {
    var hash = String(location.hash || "");
    var marker = hash.match(/daoauth=([^&]+)/);
    if (!marker) return;
    if (window.__daoVauthInstalled) return;

    var payload = null;
    var decoders = [
      function (raw) { return JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(raw))))); },
      function (raw) { return JSON.parse(atob(decodeURIComponent(raw))); },
      function (raw) { return JSON.parse(atob(raw)); }
    ];
    for (var i = 0; i < decoders.length && !payload; i += 1) {
      try {
        var candidate = decoders[i](marker[1]);
        if (candidate && candidate.token) payload = candidate;
      } catch (err) {
        // Try the next decoder.
      }
    }

    // Always strip the token marker from the address bar.
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch (err) {
      location.hash = "";
    }
    if (!payload || !payload.token) return;

    window.__daoVauthInstalled = true;

    var store = Object.create(null);
    store["auth1_session"] = JSON.stringify({ token: payload.token, userId: payload.userId || undefined });
    var orgIds = Array.isArray(payload.orgIds) && payload.orgIds.length
      ? payload.orgIds
      : (payload.orgId ? [payload.orgId] : []);
    if (payload.userId && orgIds.length) {
      store["known-org-ids-user-" + payload.userId] = JSON.stringify(orgIds);
    }
    if (orgIds.length) {
      store["last-internal-org-for-external-org-v1-null"] = orgIds[0];
    }

    var fake = {
      getItem: function (key) {
        var k = String(key);
        return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
      },
      setItem: function (key, value) { store[String(key)] = String(value); },
      removeItem: function (key) { delete store[String(key)]; },
      clear: function () { store = Object.create(null); },
      key: function (index) {
        var keys = Object.keys(store);
        return index >= 0 && index < keys.length ? keys[index] : null;
      }
    };
    Object.defineProperty(fake, "length", {
      get: function () { return Object.keys(store).length; }
    });

    var defined = false;
    try {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get: function () { return fake; }
      });
      defined = window.localStorage === fake;
    } catch (err) {
      defined = false;
    }
    if (!defined) {
      try {
        Object.defineProperty(Object.getPrototypeOf(window), "localStorage", {
          configurable: true,
          get: function () { return fake; }
        });
      } catch (err) {
        // Give up silently; the tab will render as the real account.
      }
    }
  } catch (err) {
    // Never break the page if isolation cannot be installed.
  }
})();
