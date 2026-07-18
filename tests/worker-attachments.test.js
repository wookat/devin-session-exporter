import assert from "node:assert";
import { test } from "node:test";
import {
  parseAttachmentMarker,
  attachmentName,
  attachmentRelativePath,
  proxiedAttachmentUrl,
  rewriteAttachments
} from "../worker/src/index.js";

const SHARE = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://devin-session-share.example.workers.dev";
const IMG = "https://app.devin.ai/attachments/76d27d7a-80dd-4ae0-8fd8-a037e131d927/image.png";
const DOC = "https://app.devin.ai/attachments/ea1a1dcc-fd87-49c8-8fe8-8103c2b9b5d1/note.md";

test("parseAttachmentMarker handles json, quoted, and bare forms", () => {
  assert.deepStrictEqual(
    parseAttachmentMarker(`ATTACHMENT:{"url":"${IMG}","fileSize":1234}`),
    { url: IMG, fileSize: 1234 }
  );
  assert.strictEqual(parseAttachmentMarker(`ATTACHMENT:"${IMG}"`).url, IMG);
  assert.strictEqual(parseAttachmentMarker(`ATTACHMENT:${IMG}`).url, IMG);
});

test("attachmentRelativePath extracts uuid/filename only", () => {
  assert.strictEqual(
    attachmentRelativePath(IMG),
    "76d27d7a-80dd-4ae0-8fd8-a037e131d927/image.png"
  );
  assert.strictEqual(attachmentRelativePath("https://app.devin.ai/sessions/abc"), "");
});

test("proxiedAttachmentUrl builds a worker path and encodes segments", () => {
  assert.strictEqual(
    proxiedAttachmentUrl(ORIGIN, SHARE, "uuid/my file.png"),
    `${ORIGIN}/a/${SHARE}/uuid/my%20file.png`
  );
});

test("attachmentName decodes the trailing segment", () => {
  assert.strictEqual(attachmentName("uuid/my%20file.png"), "my file.png");
});

function ctx(cookie = "attachments_token=x") {
  return { shareId: SHARE, workerOrigin: ORIGIN, cookie: async () => cookie };
}

// rewriteAttachments now probes every attachment once, so tests stub fetch.
async function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("rewriteAttachments converts accessible image markers into proxied markdown images", async () => {
  const out = await withFetch(
    async () => ({ ok: true, status: 200, text: async () => "" }),
    () => rewriteAttachments(`看图\nATTACHMENT:"${IMG}"`, ctx())
  );
  assert.match(
    out,
    new RegExp(`!\\[image\\.png\\]\\(${ORIGIN}/a/${SHARE}/76d27d7a-80dd-4ae0-8fd8-a037e131d927/image\\.png\\)`)
  );
  assert.ok(!out.includes("app.devin.ai/attachments"), "private URL must be replaced");
});

test("rewriteAttachments labels attachments the share account cannot access", async () => {
  const out = await withFetch(
    async () => ({ ok: false, status: 403, text: async () => "" }),
    () => rewriteAttachments(`ATTACHMENT:"${IMG}"`, ctx())
  );
  assert.match(out, /（附件 image\.png：由其他账号上传，此分享账号无权读取）/);
  assert.ok(!out.includes(`${ORIGIN}/a/`), "no dead proxy link for a forbidden attachment");
});

test("rewriteAttachments inlines text attachments via the proxy cookie", async () => {
  const out = await withFetch(
    async (url) => {
      assert.ok(String(url).endsWith("/attachments/ea1a1dcc-fd87-49c8-8fe8-8103c2b9b5d1/note.md"));
      return { ok: true, status: 200, text: async () => "hello handoff" };
    },
    () => rewriteAttachments(`ATTACHMENT:{"url":"${DOC}","fileSize":20}`, ctx())
  );
  assert.match(out, /<附件 note\.md>\nhello handoff\n<\/附件 note\.md>/);
});

test("rewriteAttachments falls back to a proxied link on a transient fetch failure", async () => {
  const out = await withFetch(
    async () => ({ ok: false, status: 500, text: async () => "" }),
    () => rewriteAttachments(`ATTACHMENT:{"url":"${DOC}","fileSize":20}`, ctx())
  );
  assert.strictEqual(out, `[附件 note.md](${ORIGIN}/a/${SHARE}/ea1a1dcc-fd87-49c8-8fe8-8103c2b9b5d1/note.md)`);
});

test("rewriteAttachments rewrites attachments embedded inside an inlined doc", async () => {
  const out = await withFetch(
    async () => ({
      ok: true,
      status: 200,
      text: async () => `handoff body\nATTACHMENT:{"url":"${IMG}","fileSize":700000}`
    }),
    () => rewriteAttachments(`ATTACHMENT:{"url":"${DOC}","fileSize":20}`, ctx())
  );
  assert.match(out, /<附件 note\.md>/);
  assert.match(
    out,
    new RegExp(`!\\[image\\.png\\]\\(${ORIGIN}/a/${SHARE}/76d27d7a-80dd-4ae0-8fd8-a037e131d927/image\\.png\\)`)
  );
  assert.ok(!out.includes("ATTACHMENT:"), "nested marker must be converted");
  assert.ok(!out.includes("app.devin.ai/attachments"), "nested private URL must be replaced");
});

test("rewriteAttachments leaves text without attachments untouched", async () => {
  const out = await rewriteAttachments("just a normal message", ctx());
  assert.strictEqual(out, "just a normal message");
});
