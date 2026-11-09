// ทดสอบ LINE replyToken: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";
const { resetDb, state } = await import(fake("admin"));
const { lineSend, lineSendMessages } = await import("../src/lib/channels/line.ts");
const { claimReplyToken, claimReplyTokenWithAge, lineQuotaHint, REPLY_TOKEN_MAX_AGE_MS, REPLY_TOKEN_SURE_MS } = await import("../src/lib/channels/reply-token.ts");
const { summarizeLineSends, bangkokMonthStart } = await import("../src/lib/line-usage-rules.ts");
beforeEach(() => resetDb({ line_sends: [] }));

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

test("token ยังไม่หมดอายุใช้ได้ และถูกล้างออก (ใช้ได้ครั้งเดียว)", async () => {
  const db = fakeDb(conv("T1", 10_000));
  assert.equal(await claimReplyToken(db, "c1", NOW), "T1");
  assert.equal(db.row.line_reply_token, null);
});

test("token อายุครบ 20 นาทีพอดียังลอง reply ได้", async () => {
  assert.equal(REPLY_TOKEN_MAX_AGE_MS, 20 * 60_000);
  assert.equal(await claimReplyToken(fakeDb(conv("T1", REPLY_TOKEN_MAX_AGE_MS)), "c1", NOW), "T1");
});

test("token อายุเกิน 20 นาทีต้องไม่ถูกใช้ (push เลย ไม่ลอง reply)", async () => {
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

// ---- โควตา: บันทึกทุกการส่ง รวมหลายบับเบิลใน reply เดียว ----
const sends = () => state.tables.line_sends.map((r) => [r.mode, r.kind, r.message_count, r.ok, r.fallback]);
function captureFetch(onReply) {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    const kind = String(url).endsWith("/message/reply") ? "reply" : "push";
    bodies.push({ kind, count: JSON.parse(init.body).messages.length });
    return kind === "reply" ? onReply() : new Response("{}", { status: 200 });
  };
  return bodies;
}
const msgs = (n) => Array.from({ length: n }, (_, i) => ({ type: "text", text: `m${i}` }));

test("หลายบับเบิล (รูป+ข้อความ) ส่งใน reply ครั้งเดียว และบันทึกว่าเป็น reply", async () => {
  const bodies = captureFetch(() => new Response("{}", { status: 200 }));
  await lineSendMessages("U1", msgs(2), "T1", { kind: "chat", conversationId: "c1", tokenAgeMs: 5_000 });
  assert.deepEqual(bodies, [{ kind: "reply", count: 2 }]);
  assert.deepEqual(sends(), [["reply", "chat", 2, true, false]]);
  assert.equal(state.tables.line_sends[0].token_age_ms, 5_000);
  assert.equal(state.tables.line_sends[0].conversation_id, "c1");
});

test("เกิน 5 ข้อความ: 5 แรก reply ที่เหลือ push (token ใช้ได้ครั้งเดียว)", async () => {
  const bodies = captureFetch(() => new Response("{}", { status: 200 }));
  await lineSendMessages("U1", msgs(7), "T1", { kind: "chat" });
  assert.deepEqual(bodies, [{ kind: "reply", count: 5 }, { kind: "push", count: 2 }]);
  assert.deepEqual(sends(), [["reply", "chat", 5, true, false], ["push", "chat", 2, true, false]]);
});

test("reply ไม่สำเร็จ (token หมดอายุ) → push อัตโนมัติ บันทึกว่าเป็น fallback", async () => {
  const bodies = captureFetch(() => new Response('{"message":"Invalid reply token"}', { status: 400 }));
  await lineSendMessages("U1", msgs(1), "T1", { kind: "appointment", conversationId: "c1" });
  assert.deepEqual(bodies.map((b) => b.kind), ["reply", "push"]);
  assert.deepEqual(sends(), [["reply", "appointment", 1, false, false], ["push", "appointment", 1, true, true]]);
  assert.match(state.tables.line_sends[0].error, /Invalid reply token/);
});

test("push ไม่สำเร็จ: บันทึกแล้ว throw ให้ผู้เรียกจัดการ", async () => {
  globalThis.fetch = async () => new Response("quota exceeded", { status: 429 });
  await assert.rejects(lineSendMessages("U1", msgs(1), undefined, { kind: "reminder" }), /LINE push failed 429/);
  assert.deepEqual(sends(), [["push", "reminder", 1, false, false]]);
});

test("claimReplyTokenWithAge คืนอายุ token ไว้บันทึก", async () => {
  const db = fakeDb(conv("T1", 90_000));
  assert.deepEqual(await claimReplyTokenWithAge(db, "c1", NOW), { token: "T1", ageMs: 90_000 });
});

test("ป้ายโควตาในหน้าแชท: ≤1 นาทีฟรี 1–20 นาทีอาจนับ เกิน/ไม่มี token จะนับ", () => {
  const at = (ms) => new Date(NOW - ms).toISOString();
  assert.equal(lineQuotaHint("T1", at(30_000), NOW), "free");
  assert.equal(lineQuotaHint("T1", at(REPLY_TOKEN_SURE_MS + 1), NOW), "maybe");
  assert.equal(lineQuotaHint("T1", at(REPLY_TOKEN_MAX_AGE_MS + 1), NOW), "push");
  assert.equal(lineQuotaHint(null, at(1_000), NOW), "push", "token ถูกใช้ไปแล้ว");
  assert.equal(lineQuotaHint("T1", null, NOW), "push");
  const src = readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8");
  assert.match(src, /quotaHint === "push" && \(\s*<span className="quota-hint push"[^>]*>📊 จะนับโควตา/);
});

test("สรุปเดือนนี้: push แยกประเภท (นับต่อข้อความ) reply ฟรี fallback และส่งไม่สำเร็จ", () => {
  const g = (mode, kind, ok, fallback, requests, messages) => ({ mode, kind, ok, fallback, requests, messages });
  const s = summarizeLineSends([
    g("push", "chat", true, false, 3, 4), g("push", "chat", true, true, 2, 2), g("push", "reminder", true, false, 5, 5),
    g("push", "appointment", true, false, "1", "1"), g("reply", "chat", true, false, 10, 13), g("reply", "chat", false, false, 2, 2),
    g("push", "chat", false, false, 1, 1),
  ], "2026-11");
  assert.deepEqual(s.push, { chat: 6, appointment: 1, reminder: 5, broadcast: 0 });
  assert.equal(s.pushTotal, 12);
  assert.equal(s.replyMessages, 13);
  assert.equal(s.replyRequests, 10);
  assert.equal(s.fallbacks, 2);
  assert.equal(s.failed, 1);
  assert.deepEqual(bangkokMonthStart(Date.parse("2026-11-30T18:00:00Z")), { month: "2026-12", startIso: "2026-11-30T17:00:00.000Z" }, "ต้นเดือนตามเวลาไทย");
});

test("ทุกทางส่ง LINE ผ่าน lineSendMessages (บันทึกโควตา) และระบุประเภท", () => {
  const line = readFileSync("src/lib/channels/line.ts", "utf8");
  assert.doesNotMatch(line, /message\/(push|reply)`/, "ไม่มีทางเรียก reply/push ตรงๆ นอก lineSendMessages");
  assert.equal((line.match(/post\("push"/g) ?? []).length, 1, "push ที่เดียว (บันทึกทุกครั้ง)");
  const pipeline = readFileSync("src/lib/pipeline.ts", "utf8");
  assert.equal((pipeline.match(/kind: "chat"/g) ?? []).length + (pipeline.match(/kind: "chat" as const/g) ?? []).length >= 2, true);
  const appt = readFileSync("src/lib/appointment-store.ts", "utf8");
  assert.match(appt, /kind: input\.kind === "reminder" \? "reminder" : "appointment"/);
});
