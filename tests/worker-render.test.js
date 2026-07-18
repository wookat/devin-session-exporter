import test from "node:test";
import assert from "node:assert";
import { renderMarkdown } from "../worker/src/index.js";

const T0 = Date.UTC(2026, 6, 18, 10, 0, 0);

function sampleEvents() {
  return [
    { type: "initial_user_message", message: "请把导出功能做好\n细节说明...", created_at_ms: T0 },
    { type: "devin_message", message: "好的，我开始做。", created_at_ms: T0 + 60_000 },
    { type: "shell_process_started", command: "npm test", process_id: 1, created_at_ms: T0 + 120_000 },
    { type: "shell_process_completed", process_id: 1, exit_code: 0, output_trunc: "ok", created_at_ms: T0 + 150_000 },
    { type: "shell_process_started", command: "npm run build", process_id: 2, created_at_ms: T0 + 180_000 },
    { type: "todo_update", todos: [
      { content: "写代码", status: "completed" },
      { content: "部署上线", status: "pending" }
    ], created_at_ms: T0 + 200_000 },
    { type: "devin_message", message: "代码已完成，准备部署。", created_at_ms: T0 + 240_000 }
  ];
}

test("renderMarkdown puts an AI-first TL;DR at the top", async () => {
  const md = await renderMarkdown({ title: "T", status_enum: "working" }, sampleEvents(), null);
  const tldrIndex = md.indexOf("## TL;DR");
  assert.ok(tldrIndex >= 0 && tldrIndex < md.indexOf("## 时间线（对话）"));
  assert.match(md, /- \*\*目标\*\*：请把导出功能做好/);
  assert.match(md, /- \*\*会话状态\*\*：working/);
  assert.match(md, /- \*\*TODO 进度\*\*：1\/2 完成/);
  assert.match(md, /- \[ \] 部署上线/);
  assert.match(md, /\*\*中断点\*\*：上个会话停在 `\$ npm run build`/);
  assert.match(md, /最新进展（Devin 最后一条回复）/);
  assert.match(md, /> 代码已完成，准备部署。/);
});

test("TL;DR goal strips attachment markers", async () => {
  const events = [
    { type: "initial_user_message", message: 'ATTACHMENT:"https://app.devin.ai/attachments/u1/handoff.md"\n请续接任务', created_at_ms: T0 }
  ];
  const md = await renderMarkdown({ title: "T" }, events, null);
  assert.match(md, /- \*\*目标\*\*：请续接任务/);
  const onlyAttachment = [
    { type: "initial_user_message", message: 'ATTACHMENT:"https://app.devin.ai/attachments/u1/handoff.md"', created_at_ms: T0 }
  ];
  const md2 = await renderMarkdown({ title: "T" }, onlyAttachment, null);
  assert.match(md2, /- \*\*目标\*\*：（首条消息为附件：handoff.md）/);
});

test("renderMarkdown timestamps conversation and marks interrupted commands", async () => {
  const md = await renderMarkdown({ title: "T" }, sampleEvents(), null);
  assert.match(md, /### \[07-18 10:00\] User/);
  assert.match(md, /### \[07-18 10:04\] Devin/);
  assert.match(md, /- \[07-18 10:02\] \$ npm test  → 退出码 0/);
  assert.match(md, /- \[07-18 10:03\] \$ npm run build  ⏳（未见完成事件，可能在此中断）/);
});
