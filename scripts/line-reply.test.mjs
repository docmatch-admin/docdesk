// ทดสอบ LINE replyToken: npm test
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { lineSend } from "../src/lib/channels/line.ts";
import { claimReplyToken, REPLY_TOKEN_MAX_AGE_MS } from "../src/lib/channels/reply-token.ts";

/** จำลองแถวเดียวในตาราง conversations พอให้ทดสอบ select + update แบบมีเงื่อนไข */
function fakeDb(row) {
  return {
    row,
    from() {
      const filters = [];
      let patch = null;
      const matches = () => filters.every(([k, v]) => row[k] === v);
      const builder = {
        select() { return builder; },
        update(p) { patch = p; return builder; },
        eq(k, v) { filters.push([k, v]); return builder; },
        single: async () => ({ data: matches() ? { ...row } : null }),
        then(resolve) {
          if (!patch || !matches()) return resolve({ data: [] });
          Object.assign(row, patch);
          return resolve({ data: [{ id: row.id }] });
        },
      };
      return builder;
    },
  };
}
const NOW = Date.parse("2026-11-01T10:00:00Z");
const conv = (token, ageMs) => ({
  id: "c1", line_reply_token: token, line_reply_token_at: new Date(NOW - ageMs).toISOString(),
});

test("token อายุไม่เกิน 50 วินาทีใช้ได้ และถูกล้างออก", async () => {
  const db = fakeDb(conv("T1", 10_000));
  assert.equal(await claimReplyToken(db, "c1", NOW), "T1");
  assert.equal(db.row.line_reply_token, null);
});

test("token อายุครบ 50 วินาทีพอดียังใช้ได้", async () => {
  assert.equal(await claimReplyToken(fakeDb(conv("T1", REPLY_TOKEN_MAX_AGE_MS)), "c1", NOW), "T1");
});

test("token อายุเกิน 50 วินาทีต้องไม่ถูกใช้", async () => {
  const db = fakeDb(conv("T1", REPLY_TOKEN_MAX_AGE_MS + 1));
  assert.equal(await claimReplyToken(db, "c1", NOW), undefined);
  assert.equal(db.row.line_reply_token, "T1");
});

test("token ถูก claim แล้วห้ามใช้ซ้ำ", async () => {
  const db = fakeDb(conv("T1", 1_000));
  assert.equal(await claimReplyToken(db, "c1", NOW), "T1");
  assert.equal(await claimReplyToken(db, "c1", NOW), undefined);
});

test("claim พร้อมกัน 2 ครั้ง ได้ token แค่ครั้งเดียว", async () => {
  const db = fakeDb(conv("T1", 1_000));
  const got = await Promise.all([claimReplyToken(db, "c1", NOW), claimReplyToken(db, "c1", NOW)]);
  assert.deepEqual(got.filter(Boolean), ["T1"]);
});

test("ไม่มี token หรือไม่มีเวลาเก็บ ต้องไม่ถูกใช้", async () => {
  assert.equal(await claimReplyToken(fakeDb(conv(null, 0)), "c1", NOW), undefined);
  const db = fakeDb({ id: "c1", line_reply_token: "T1", line_reply_token_at: null });
  assert.equal(await claimReplyToken(db, "c1", NOW), undefined);
});

// ---- ส่ง LINE: reply ก่อน ถ้าไม่สำเร็จค่อย push ----
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function mockFetch(onReply) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const kind = String(url).endsWith("/message/reply") ? "reply" : "push";
    calls.push(kind);
    return kind === "reply" ? onReply() : new Response("{}", { status: 200 });
  };
  return calls;
}

test("reply สำเร็จ ไม่ต้อง push", async () => {
  const calls = mockFetch(() => new Response("{}", { status: 200 }));
  await lineSend("U1", "สวัสดี", "T1");
  assert.deepEqual(calls, ["reply"]);
});

test("reply ไม่สำเร็จ (token หมดอายุ) fallback เป็น push", async () => {
  const calls = mockFetch(() => new Response("{}", { status: 400 }));
  await lineSend("U1", "สวัสดี", "T1");
  assert.deepEqual(calls, ["reply", "push"]);
});

test("reply เจอ network error fallback เป็น push", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = mockFetch(() => { throw new Error("network down"); });
  await lineSend("U1", "สวัสดี", "T1");
  assert.deepEqual(calls, ["reply", "push"]);
});

test("ไม่มี token ใช้ push อย่างเดียว", async () => {
  const calls = mockFetch(() => new Response("{}", { status: 200 }));
  await lineSend("U1", "สวัสดี");
  assert.deepEqual(calls, ["push"]);
});
