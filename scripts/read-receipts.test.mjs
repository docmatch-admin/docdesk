// ทดสอบสถานะ "อ่านแล้ว": npm test
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./fakes/hooks.mjs";
const { lineMarkAsRead } = await import("../src/lib/channels/line.ts");
const { metaMarkSeen, parseMetaReads } = await import("../src/lib/channels/meta.ts");
const { applyCustomerRead, findConversationId, markConversationReadWith } = await import("../src/lib/read-receipts.ts");

const NOW = Date.parse("2026-11-01T10:00:00Z");
const HOUR = 3_600_000;
const ago = (ms) => new Date(NOW - ms).toISOString();

/** จำลองตารางในหน่วยความจำ พอให้ทดสอบ select + update แบบมีเงื่อนไข */
function fakeDb(tables) {
  const get = (row, path) => path.split(".").reduce((v, k) => v?.[k], row);
  return {
    tables,
    from(name) {
      const filters = [];
      let patch = null, sort = null, max = Infinity;
      const rows = () => {
        let out = tables[name].filter((r) => filters.every((f) => f(r)));
        if (sort) out = [...out].sort((a, b) => Date.parse(b[sort]) - Date.parse(a[sort]));
        return out.slice(0, max);
      };
      const builder = {
        select() { return builder; },
        update(p) { patch = p; return builder; },
        eq(k, v) { filters.push((r) => get(r, k) === v); return builder; },
        is(k, v) { filters.push((r) => (r[k] ?? null) === v); return builder; },
        lte(k, v) { filters.push((r) => Date.parse(r[k]) <= Date.parse(v)); return builder; },
        neq(k, v) { filters.push((r) => r[k] !== v); return builder; },
        order(k) { sort = k; return builder; },
        limit(n) { max = n; return builder; },
        single: async () => ({ data: rows()[0] ?? null }),
        maybeSingle: async () => ({ data: rows()[0] ?? null }),
        then(resolve) {
          const hit = rows();
          if (patch) hit.forEach((r) => Object.assign(r, patch));
          return resolve({ data: hit, error: null });
        },
      };
      return builder;
    },
  };
}

function setup(type, messages, markedAt = null) {
  return fakeDb({
    conversations: [{
      id: "c1", customer_marked_read_at: markedAt,
      contacts: { external_id: "U1" }, channels: { type },
    }],
    messages: messages.map((m) => ({ conversation_id: "c1", direction: "in", ...m })),
  });
}
function spies() {
  const calls = { line: [], meta: [] };
  return {
    calls,
    senders: {
      line: async (t) => { calls.line.push(t); },
      meta: async (k, id) => { calls.meta.push([k, id]); },
    },
  };
}

test("LINE: ส่ง token ของข้อความเข้าล่าสุดตัวเดียว", async () => {
  const db = setup("line", [
    { created_at: ago(3000), line_mark_as_read_token: "old" },
    { created_at: ago(1000), line_mark_as_read_token: "latest" },
    { created_at: ago(2000), line_mark_as_read_token: "middle" },
    { created_at: ago(500), direction: "out", line_mark_as_read_token: null },
  ]);
  const { calls, senders } = spies();
  assert.equal(await markConversationReadWith(db, "c1", senders, NOW), "marked");
  assert.deepEqual(calls.line, ["latest"]);
  assert.equal(db.tables.conversations[0].customer_marked_read_at, new Date(NOW).toISOString());
});

test("ไม่เรียกซ้ำเมื่อไม่มีข้อความเข้าใหม่ และเรียกอีกครั้งเมื่อมีข้อความใหม่", async () => {
  const db = setup("line", [{ created_at: ago(1000), line_mark_as_read_token: "T1" }]);
  const { calls, senders } = spies();
  assert.equal(await markConversationReadWith(db, "c1", senders, NOW), "marked");
  assert.equal(await markConversationReadWith(db, "c1", senders, NOW + 1000), "already_read");
  assert.deepEqual(calls.line, ["T1"]);

  db.tables.messages.push({ conversation_id: "c1", direction: "in", created_at: new Date(NOW + 2000).toISOString(), line_mark_as_read_token: "T2" });
  assert.equal(await markConversationReadWith(db, "c1", senders, NOW + 3000), "marked");
  assert.deepEqual(calls.line, ["T1", "T2"]);
});

test("นาฬิกาแอปช้ากว่าฐานข้อมูล: ไม่เรียก API ซ้ำ", async () => {
  const db = setup("line", [{ created_at: new Date(NOW + 5000).toISOString(), line_mark_as_read_token: "T1" }]);
  const { calls, senders } = spies();
  await markConversationReadWith(db, "c1", senders, NOW);
  assert.equal(await markConversationReadWith(db, "c1", senders, NOW + 1000), "already_read");
  assert.equal(calls.line.length, 1);
});

test("LINE: ข้อความเก่าที่ไม่มี token ข้าม และไม่บันทึกว่าแจ้งแล้ว", async () => {
  const db = setup("line", [{ created_at: ago(1000), line_mark_as_read_token: null }]);
  const { calls, senders } = spies();
  assert.equal(await markConversationReadWith(db, "c1", senders, NOW), "no_token");
  assert.equal(calls.line.length, 0);
  assert.equal(db.tables.conversations[0].customer_marked_read_at, null);
});

for (const kind of ["facebook", "instagram"]) {
  test(`${kind}: mark_seen ภายใน 24 ชม. ส่งได้`, async () => {
    const db = setup(kind, [{ created_at: ago(24 * HOUR) }]);
    const { calls, senders } = spies();
    assert.equal(await markConversationReadWith(db, "c1", senders, NOW), "marked");
    assert.deepEqual(calls.meta, [[kind, "U1"]]);
  });

  test(`${kind}: mark_seen เกิน 24 ชม. ข้ามเงียบๆ`, async (t) => {
    const log = t.mock.method(console, "error", () => {});
    const db = setup(kind, [{ created_at: ago(24 * HOUR + 1) }]);
    const { calls, senders } = spies();
    assert.equal(await markConversationReadWith(db, "c1", senders, NOW), "window_closed");
    assert.equal(calls.meta.length, 0);
    assert.equal(log.mock.callCount(), 0);
  });
}

test("web: บันทึกเวลาอ่านโดยไม่เรียก API", async () => {
  const db = setup("web", [{ created_at: ago(1000) }]);
  const { calls, senders } = spies();
  assert.equal(await markConversationReadWith(db, "c1", senders, NOW), "marked");
  assert.deepEqual(calls, { line: [], meta: [] });
  assert.equal(db.tables.conversations[0].customer_marked_read_at, new Date(NOW).toISOString());
});

test("ไม่มีข้อความเข้า: ไม่เรียก API", async () => {
  const db = setup("line", [{ created_at: ago(1000), direction: "out" }]);
  const { calls, senders } = spies();
  assert.equal(await markConversationReadWith(db, "c1", senders, NOW), "no_message");
  assert.equal(calls.line.length, 0);
});

test("API error: ไม่ throw แค่ log และไม่บันทึกเวลา เพื่อให้ลองใหม่ได้", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const db = setup("line", [{ created_at: ago(1000), line_mark_as_read_token: "T1" }]);
  const senders = { line: async () => { throw new Error("LINE down"); }, meta: async () => {} };
  assert.equal(await markConversationReadWith(db, "c1", senders, NOW), "failed");
  assert.equal(log.mock.callCount(), 1);
  assert.equal(db.tables.conversations[0].customer_marked_read_at, null);
});

// ---- คำขอที่ส่งไปแพลตฟอร์ม ----
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function mockFetch(status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response("{}", { status });
  };
  return calls;
}

test("LINE markAsRead: URL และ body ตรงตามเอกสาร", async () => {
  const calls = mockFetch();
  await lineMarkAsRead("T1");
  assert.equal(calls[0].url, "https://api.line.me/v2/bot/chat/markAsRead");
  assert.deepEqual(calls[0].body, { markAsReadToken: "T1" });
});

test("Meta mark_seen: ส่ง sender_action โดยไม่มีข้อความ", async () => {
  const calls = mockFetch();
  await metaMarkSeen("facebook", "U1");
  assert.match(calls[0].url, /\/me\/messages\?/);
  assert.deepEqual(calls[0].body, { recipient: { id: "U1" }, sender_action: "mark_seen" });
});

test("API ตอบ error ต้อง throw ให้ตัวเรียก log", async () => {
  mockFetch(400);
  await assert.rejects(lineMarkAsRead("T1"), /400/);
  await assert.rejects(metaMarkSeen("instagram", "U1"), /400/);
});

// ---- ลูกค้าอ่านแล้ว ----
test("watermark อัปเดตเฉพาะข้อความขาออกที่ส่งไม่เกิน watermark และยังไม่เคยอ่าน", async () => {
  const earlier = ago(HOUR);
  const db = fakeDb({ messages: [
    { id: "before", conversation_id: "c1", direction: "out", created_at: ago(2000), read_by_customer_at: null },
    { id: "exact", conversation_id: "c1", direction: "out", created_at: ago(1000), read_by_customer_at: null },
    { id: "after", conversation_id: "c1", direction: "out", created_at: ago(999), read_by_customer_at: null },
    { id: "inbound", conversation_id: "c1", direction: "in", created_at: ago(5000), read_by_customer_at: null },
    { id: "other-chat", conversation_id: "c2", direction: "out", created_at: ago(5000), read_by_customer_at: null },
    { id: "already", conversation_id: "c1", direction: "out", created_at: ago(5000), read_by_customer_at: earlier },
  ] });
  const readAt = new Date(NOW);
  await applyCustomerRead(db, "c1", ago(1000), readAt);
  const state = Object.fromEntries(db.tables.messages.map((m) => [m.id, m.read_by_customer_at]));
  assert.deepEqual(state, {
    before: readAt.toISOString(), exact: readAt.toISOString(), after: null,
    inbound: null, "other-chat": null, already: earlier,
  });
});

test("แปลง event อ่านของ Messenger: ใช้ watermark และข้าม event ของเพจเอง", () => {
  const reads = parseMetaReads({ object: "page", entry: [{ id: "PAGE", messaging: [
    { sender: { id: "U1" }, recipient: { id: "PAGE" }, timestamp: 2000, read: { watermark: 1500 } },
    { sender: { id: "PAGE" }, recipient: { id: "U1" }, timestamp: 2000, read: { watermark: 1500 } },
    { sender: { id: "U2" }, recipient: { id: "PAGE" }, message: { mid: "m", text: "x" } },
  ] }] });
  assert.deepEqual(reads, [{ kind: "facebook", senderId: "U1", watermark: 1500, readAt: 2000 }]);
});

test("แปลง event อ่านของ Instagram: ไม่มี watermark ใช้เวลาของ event", () => {
  const reads = parseMetaReads({ object: "instagram", entry: [{ id: "IGB", messaging: [
    { sender: { id: "IGSID" }, recipient: { id: "IGB" }, timestamp: 3000, read: { mid: "abc" } },
  ] }] });
  assert.deepEqual(reads, [{ kind: "instagram", senderId: "IGSID", watermark: 3000, readAt: 3000 }]);
  assert.deepEqual(parseMetaReads({ object: "other", entry: [] }), []);
});

test("หาแชทจากรหัสลูกค้าตามช่องทาง", async () => {
  const db = fakeDb({
    contacts: [
      { id: "ct-line", external_id: "U1", channels: { type: "line" } },
      { id: "ct-fb", external_id: "U1", channels: { type: "facebook" } },
    ],
    conversations: [{ id: "conv-line", contact_id: "ct-line" }, { id: "conv-fb", contact_id: "ct-fb" }],
  });
  assert.equal(await findConversationId(db, "facebook", "U1"), "conv-fb");
  assert.equal(await findConversationId(db, "instagram", "U1"), null);
});
