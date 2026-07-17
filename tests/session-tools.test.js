import assert from "node:assert";
import { test } from "node:test";
import * as mod from "../src/core.js";

test("parseBatchAccounts handles multiple separators and json", () => {
  let r = mod.parseBatchAccounts([
    "a@x.com---pw1---note",
    "b@x.com----pw2",
    "c@x.com:pw3",
    "d@x.com\tpw4",
    "e@x.com|pw5",
    "f@x.com,pw6",
    "g@x.com pw7",
    '{"email":"h@x.com","password":"pw8","label":"H"}',
    "notanemail-pw",
    "   "
  ].join("\n"));
  assert.strictEqual(r.accounts.length, 8);
  assert.strictEqual(r.skipped, 1);
  assert.deepStrictEqual(r.accounts[0], { label: "a@x.com", email: "a@x.com", password: "pw1" });
  assert.strictEqual(r.accounts[2].password, "pw3");
  assert.strictEqual(r.accounts[6].password, "pw7");
  assert.strictEqual(r.accounts[7].label, "H");
  assert.strictEqual(r.accounts[7].email, "h@x.com");

  r = mod.parseBatchAccounts('[{"email":"z@x.com","pwd":"zz"},{"user":"nope"}]');
  assert.strictEqual(r.accounts.length, 1);
  assert.strictEqual(r.accounts[0].email, "z@x.com");
  assert.strictEqual(r.accounts[0].password, "zz");
  assert.strictEqual(r.skipped, 1);

  r = mod.parseBatchAccounts("m1@x.com----pwA\nm2@x.com----pwB----extra");
  assert.strictEqual(r.accounts.length, 2);
  assert.strictEqual(r.accounts[1].password, "pwB");
});

test("normalizeSessionRecord derives ids", () => {
  let s = mod.normalizeSessionRecord({ session_id: "devin-abc", title: "Hello", status_enum: "running", created_at: "t1" });
  assert.strictEqual(s.devinId, "devin-abc");
  assert.strictEqual(s.sessionId, "abc");
  assert.strictEqual(s.status, "running");
  s = mod.normalizeSessionRecord({ id: "xyz" });
  assert.strictEqual(s.devinId, "devin-xyz");
  assert.strictEqual(s.title, "xyz");
  s = mod.normalizeSessionRecord({ url: "https://app.devin.ai/sessions/qqq?tab=1" });
  assert.strictEqual(s.sessionId, "qqq");
});

test("vauth payload + url round-trip", () => {
  const auth = { token: "tok123", userId: "u1", orgId: "org-1", email: "a@x.com" };
  const url = mod.buildIsolatedSessionUrl({ sessionId: "sid9" }, auth);
  assert.ok(url.startsWith("https://app.devin.ai/sessions/sid9#daoauth="));
  const b64 = decodeURIComponent(url.split("#daoauth=")[1]);
  const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  assert.strictEqual(decoded.token, "tok123");
  assert.strictEqual(decoded.orgId, "org-1");
  assert.deepStrictEqual(decoded.orgIds, ["org-1"]);
});

test("balance display prioritises overage credits", () => {
  assert.strictEqual(
    mod.formatBalanceDisplay({ overageCredits: -0.16, availableCredits: 12.5, maxAcuLimit: 200 }),
    "余额 $-0.16 · 上限 $200"
  );
  assert.strictEqual(
    mod.formatBalanceDisplay({ overageCredits: 5, maxAcuLimit: 200 }),
    "余额 $5.00 · 上限 $200"
  );
  assert.strictEqual(mod.accountAvailableBalance({ overageCredits: 80, availableCredits: 0 }), 80);
  assert.strictEqual(mod.accountAvailableBalance({ availableCredits: 70 }), 70);
  assert.strictEqual(mod.balanceToneClass({ availableCredits: 70 }), "balance-positive");
  assert.strictEqual(mod.balanceToneClass({ availableCredits: 40 }), "balance-negative");
});

test("fileDateStamp is human-readable", () => {
  assert.strictEqual(mod.fileDateStamp(new Date(2026, 6, 17, 16, 30)), "2026-07-17_16-30");
});

test("selectNextAccount honours the balance floor", () => {
  const accts = [{ email: "a@x.com" }, { email: "b@x.com" }, { email: "c@x.com" }];
  const balances = new Map([
    ["a@x.com", { availableCredits: 10 }],
    ["b@x.com", { availableCredits: 100 }],
    ["c@x.com", { availableCredits: 200 }]
  ]);
  assert.strictEqual(mod.selectNextAccount(accts, "a@x.com", "", { balances, minBalance: 65 }).email, "b@x.com");
  assert.strictEqual(mod.selectNextAccount(accts, "b@x.com", "", { balances, minBalance: 65 }).email, "c@x.com");
  assert.strictEqual(
    mod.selectNextAccount(accts, "a@x.com", "", {
      balances: new Map([["a@x.com", { availableCredits: 1 }]]),
      minBalance: 65
    }),
    null
  );
  assert.strictEqual(mod.selectNextAccount(accts, "a@x.com").email, "b@x.com");
});

test("pickLatestSession returns most recently updated", () => {
  assert.strictEqual(mod.pickLatestSession([]), null);
  assert.strictEqual(
    mod.pickLatestSession([
      { sessionId: "old", updatedAt: "2026-01-01T00:00:00Z" },
      { sessionId: "new", updatedAt: "2026-07-01T00:00:00Z" },
      { sessionId: "mid", createdAt: "2026-03-01T00:00:00Z" }
    ]).sessionId,
    "new"
  );
});

test("formatSessionStatus maps known states", () => {
  assert.strictEqual(mod.formatSessionStatus("running"), "正在运行");
  assert.strictEqual(mod.formatSessionStatus("blocked"), "等待输入");
  assert.strictEqual(mod.formatSessionStatus("custom_state"), "custom_state");
  assert.strictEqual(mod.formatSessionStatus(""), "状态未知");
});
