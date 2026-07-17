import assert from "node:assert";
import { test } from "node:test";
import * as mod from "../src/core.js";

test("summarizeAttachmentMarkers strips auth-gated links", () => {
  let t = mod.summarizeAttachmentMarkers(
    'see this\nATTACHMENT:{"url":"https://app.devin.ai/attachments/x/report.md","fileSize":23075}\nend'
  );
  assert.ok(t.includes("[附件已省略：report.md · 23KB]"), t);
  assert.ok(!t.includes("ATTACHMENT:"));
  t = mod.summarizeAttachmentMarkers('ATTACHMENT:"https://app.devin.ai/attachments/y/image.png"');
  assert.ok(t.includes("[附件已省略：image.png]"), t);
});

test("collapseNoise truncates and dedupes clusters", () => {
  const long = "x".repeat(2000);
  const c = mod.collapseNoise(long, { maxLen: 800 });
  assert.ok(c.length < 900 && c.includes("已截断"));

  const cluster = "接入方式 tailscale status 使用 sgpu --help 连接 ssh dell@xu-1 " + "详情".repeat(300);
  const seen = new Set();
  const first = mod.collapseNoise(cluster, { maxLen: 5000, seen });
  const second = mod.collapseNoise(cluster, { maxLen: 5000, seen });
  assert.ok(first.length > 100);
  assert.ok(second.includes("已折叠"), second);
});

test("summarizeTodos counts statuses", () => {
  const s = mod.summarizeTodos([
    { status: "completed", content: "a" },
    { status: "completed", content: "b" },
    { status: "in_progress", content: "c" },
    { status: "pending", content: "d" }
  ]);
  assert.deepStrictEqual(s, { total: 4, done: 2, inProgress: 1, pending: 1 });
});

test("buildHandoff has TL;DR and hides full conversation by default", () => {
  const data = {
    title: "T", url: "u", exportedAt: "now",
    messages: [
      { role: "user", type: "user_message", text: "帮我写一个扩展" },
      { role: "devin", type: "devin_message", text: "好的，我来做。" },
      { role: "user", type: "user_message", text: 'ATTACHMENT:{"url":"https://a/x.png","fileSize":700000}' }
    ],
    worklog: [
      { kind: "todos", todos: [
        { status: "completed", content: "done thing" },
        { status: "in_progress", content: "current thing" },
        { status: "pending", content: "next thing" }
      ] }
    ]
  };
  const h = mod.buildHandoff(data);
  assert.ok(h.includes("## TL;DR"));
  assert.ok(h.includes("目标：帮我写一个扩展"));
  assert.ok(h.includes("进度：1/3 完成"));
  assert.ok(h.includes("[ ] current thing"));
  assert.ok(!h.includes("## Full conversation"));
  assert.ok(h.includes("[附件已省略：x.png"));

  const hf = mod.buildHandoff(data, { includeFullConversation: true });
  assert.ok(hf.includes("## Full conversation"));
});

test("buildHandoff captures interrupted commands", () => {
  const interrupted = {
    title: "T", url: "u", exportedAt: "now",
    messages: [{ role: "user", type: "user_message", text: "跑训练" }],
    worklog: [
      { kind: "command", timestamp: "2026-07-17T00:00:00.000Z", command: "cd /repo && ls", exitCode: 0, completedAt: "2026-07-17T00:00:01.000Z" },
      { kind: "file", timestamp: "2026-07-17T00:00:02.000Z", action: "edit", path: "train.py" },
      { kind: "command", timestamp: "2026-07-17T00:00:03.000Z", command: "python train.py --epochs 100" }
    ]
  };
  const hi = mod.buildHandoff(interrupted);
  assert.ok(hi.includes("## 最近操作步骤（含进行中）"));
  assert.ok(hi.includes("$ cd /repo && ls  → 退出码 0"));
  assert.ok(hi.includes("编辑 train.py"));
  assert.ok(hi.includes("## 中断点（上个会话停在这一步）"));
  assert.ok(hi.includes("python train.py --epochs 100  ⏳（进行中/在此中断，尚未返回结果）"));
});

test("inlineAttachmentsInText inlines text and skips images", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    text: async () => (url.endsWith(".md") ? "# inlined content" : "")
  });
  try {
    const inlined = await mod.inlineAttachmentsInText(
      'ATTACHMENT:{"url":"https://a/notes.md","fileSize":100}', "tok", "org-1"
    );
    assert.ok(inlined.includes("<附件 notes.md>") && inlined.includes("# inlined content"), inlined);
    const img = await mod.inlineAttachmentsInText('ATTACHMENT:"https://a/pic.png"', "tok", "org-1");
    assert.ok(img.includes("[附件已省略：pic.png]") && !img.includes("<附件"), img);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
