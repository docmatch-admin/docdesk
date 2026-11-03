// ทดสอบการย้ายแท็บ inbox ด้วยโค้ดจริงของ pipeline: npm test
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import sharp from "sharp";
import { fake } from "./fakes/hooks.mjs";

const { replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const {
  aiTiming, autoCloseQuietChats, markConversationRead, processIncoming, sendMediaReply, sendReply, setConversationTag, storeIncoming,
} = await import("../src/lib/pipeline.ts");
const { CLOSE_PATCH, DEFAULT_AUTO_CLOSE_HOURS, nextOpenChat, normalizeAutoCloseHours, tabsOf } = await import("../src/lib/case-flow.ts");

process.env.MEDIA_URL_SECRET = "test-secret";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-token";

const SESSION = "11111111-1111-4111-8111-111111111111";
const ALL = ["open"];
const WAITING = ["open", "waiting"];
const DONE = ["closed"];

function setup(mode = "off", extraSettings = []) {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: mode }, ...extraSettings],
    channels: [{ id: "ch", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [],
    conversations: [],
    tags: [],
    tag_rules: [],
    tag_events: [],
  });
  aiTiming.debounceMs = 5;
}
beforeEach(() => setup());

const conv = () => state.tables.conversations[0];
const tabs = () => tabsOf(conv());
const customer = (text = "สอบถามหน่อยค่ะ", extra = {}) => storeIncoming({ channelType: "web", externalId: SESSION, text, ...extra });
const staffReply = (id) => sendReply({ conversationId: id, textTh: "ได้เลยค่ะ", senderType: "staff", senderId: "s1" });
const closeViaDb = async () => {
  const { supabaseAdmin } = await import(fake("admin"));
  await supabaseAdmin().from("conversations").update(CLOSE_PATCH).eq("id", conv().id);
};
const reopenViaDb = async () => {
  const { supabaseAdmin } = await import(fake("admin"));
  await supabaseAdmin().from("conversations").update({ status: "open" }).eq("id", conv().id);
};

// ---- นิยามแท็บ ----
test("นิยามแท็บ", () => {
  assert.deepEqual(tabsOf({ status: "open", last_direction: "in" }), WAITING);
  assert.deepEqual(tabsOf({ status: "open", last_direction: "out" }), ALL);
  assert.deepEqual(tabsOf({ status: "open", last_direction: null }), ALL);
  assert.deepEqual(tabsOf({ status: "closed", last_direction: "in" }), DONE);
  assert.deepEqual(tabsOf({ status: "closed", last_direction: "out" }), DONE);
});

// ---- ข้อความเข้าและตอบ ----
test("ลูกค้าทักครั้งแรก: อยู่ทั้งหมดและรอตอบ", async () => {
  await customer();
  assert.deepEqual(tabs(), WAITING);
});

test("เจ้าหน้าที่ตอบ: ออกจากรอตอบ เหลือทั้งหมด", async () => {
  const s = await customer();
  await staffReply(s.conversationId);
  assert.deepEqual(tabs(), ALL);
});

test("ลูกค้าถามต่อหลังตอบ: กลับเข้ารอตอบ", async () => {
  const s = await customer();
  await staffReply(s.conversationId);
  await customer("แล้ววันเสาร์เปิดไหมคะ");
  assert.deepEqual(tabs(), WAITING);
});

test("ลูกค้าขอบคุณหลังตอบ: ย้ายไปเสร็จแล้ว ไม่เข้ารอตอบ", async () => {
  const s = await customer();
  await staffReply(s.conversationId);
  await customer("ขอบคุณค่ะ");
  assert.equal(conv().status, "closed");
});

test("เปิดอ่านอย่างเดียว: ยังอยู่ในรอตอบ", async () => {
  const s = await customer();
  await markConversationRead(s.conversationId);
  conv().unread_count = 0;
  assert.deepEqual(tabs(), WAITING);
});

test("ลูกค้าส่งรูปอย่างเดียว: เข้ารอตอบ พร้อมต้องให้คนตอบ", async () => {
  await customer("", { isImage: true });
  assert.deepEqual(tabs(), WAITING);
  assert.equal(conv().needs_human, true);
});

test("คำขอบคุณที่ AI ไม่ร่าง: ยังอยู่ในรอตอบ", async () => {
  setup("auto");
  const s = await customer("ขอบคุณค่ะ");
  await processIncoming(s.conversationId, s.messageId);
  assert.deepEqual(tabs(), WAITING);
});

// ---- AI ----
const aiReply = (confidence, needs_human = false) => ({
  needs_human, suggested_tags: [], options: [{ text: "ร่าง", source: "knowledge", ref_ids: [], confidence }],
});

test("AI ตอบเองสำเร็จ: ออกจากรอตอบ", async () => {
  setup("auto");
  replies.next = aiReply(0.9);
  const s = await customer("วัคซีนราคาเท่าไหร่");
  await processIncoming(s.conversationId, s.messageId);
  assert.deepEqual(tabs(), ALL);
});

test("AI ไม่มั่นใจ: ยังอยู่ในรอตอบ และติดต้องให้คนตอบ", async () => {
  setup("auto");
  replies.next = aiReply(0.3);
  const s = await customer("วัคซีนราคาเท่าไหร่");
  await processIncoming(s.conversationId, s.messageId);
  assert.deepEqual(tabs(), WAITING);
  assert.equal(conv().needs_human, true);
});

test("โหมดผู้ช่วย: คำแนะนำไม่ย้ายแท็บ", async () => {
  setup("assist");
  const s = await customer("วัคซีนราคาเท่าไหร่");
  await processIncoming(s.conversationId, s.messageId);
  assert.deepEqual(tabs(), WAITING);
});

// ---- กดเสร็จแล้ว ----
test("กดเสร็จแล้วตอนรอตอบ: เหลือเสร็จแล้ว ล้าง needs_human และ ai_due_at", async () => {
  await customer();
  conv().needs_human = true;
  conv().ai_due_at = new Date().toISOString();
  await closeViaDb();
  assert.deepEqual(tabs(), DONE);
  assert.equal(conv().needs_human, false);
  assert.equal(conv().ai_due_at, null);
  assert.ok(conv().closed_at);
});

test("กดเสร็จแล้วหลังตอบแล้ว: เหลือเสร็จแล้ว", async () => {
  const s = await customer();
  await staffReply(s.conversationId);
  await closeViaDb();
  assert.deepEqual(tabs(), DONE);
});

test("เจ้าหน้าที่ตอบในแชทที่เสร็จแล้ว: ยังอยู่เสร็จแล้ว", async () => {
  const s = await customer();
  await closeViaDb();
  await staffReply(s.conversationId);
  assert.deepEqual(tabs(), DONE);
});

// ---- เปิดใหม่ ----
test("เปิดใหม่เอง ข้อความล่าสุดเป็นของลูกค้า: กลับเข้ารอตอบ", async () => {
  await customer();
  await closeViaDb();
  await reopenViaDb();
  assert.deepEqual(tabs(), WAITING);
  assert.ok(conv().waiting_since);
});

test("เปิดใหม่เอง ข้อความล่าสุดเป็นของเรา: อยู่แค่ทั้งหมด", async () => {
  const s = await customer();
  await staffReply(s.conversationId);
  await closeViaDb();
  await reopenViaDb();
  assert.deepEqual(tabs(), ALL);
});

// ---- ลูกค้าทักกลับ ----
test("ลูกค้าทักแชทที่เสร็จแล้ว: กลับเข้ารอตอบ และเอานัดแล้วออก เก็บแท็กอื่น", async () => {
  const s = await customer();
  await setConversationTag(s.conversationId, "นัดแล้ว", "add", "staff");
  await setConversationTag(s.conversationId, "วัคซีน", "add", "staff");
  await staffReply(s.conversationId);
  await closeViaDb();
  assert.deepEqual(tabs(), DONE);
  await customer("สอบถามเพิ่มค่ะ");
  assert.deepEqual(tabs(), WAITING);
  assert.deepEqual(conv().tags, ["วัคซีน"]);
});

test("ลูกค้าส่งรูปในแชทที่เสร็จแล้ว: กลับเข้ารอตอบ", async () => {
  await customer();
  await closeViaDb();
  await customer("", { isImage: true });
  assert.deepEqual(tabs(), WAITING);
});

test("เวลารอหลังทักกลับ: ไม่นับข้อความก่อนกดเสร็จแล้ว", async () => {
  await customer("ข้อความเก่า");
  await closeViaDb();
  const closedAt = conv().closed_at;
  await customer("ข้อความใหม่");
  assert.ok(Date.parse(conv().waiting_since) > Date.parse(closedAt));
});

test("ทักซ้ำระหว่างรอ: เวลารอยังนับจากข้อความแรก", async () => {
  await customer("ข้อความแรก");
  const first = conv().waiting_since;
  await customer("ข้อความสอง");
  assert.equal(conv().waiting_since, first);
  assert.notEqual(conv().last_inbound_at, first);
});

// ---- ส่งรูปล้มเหลว ----
test("ส่งรูปล้มเหลว: กลับเข้ารอตอบ", async (t) => {
  setup();
  state.tables.channels[0].type = "line";
  const s = await storeIncoming({ channelType: "line", externalId: "U1", text: "ขอแผนที่" });
  const jpg = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } }).jpeg().toBuffer();
  state.files["chat-media"] = new Map([["uploads/staff-1", { data: jpg }]]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  t.after(() => { globalThis.fetch = realFetch; });
  await assert.rejects(sendMediaReply({ conversationId: s.conversationId, uploadPath: "uploads/staff-1", senderId: "s1", origin: "https://app.test" }));
  assert.deepEqual(tabs(), WAITING);
});

// ---- ย้ายอัตโนมัติ ----
const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-10T00:00:00Z");
const ago = (h) => new Date(NOW - h * HOUR).toISOString();

function quietChat(patch = {}) {
  state.tables.conversations.push({
    id: `c${state.tables.conversations.length + 1}`, status: "open", last_direction: "out", last_message_at: ago(25),
    needs_human: false, tags: [], reopened_at: null, ...patch,
  });
  return state.tables.conversations.at(-1);
}

test("เงียบเกิน 24 ชม.: ย้ายไปเสร็จแล้ว", async () => {
  const c = quietChat();
  assert.equal(await autoCloseQuietChats(NOW), 1);
  assert.deepEqual(tabsOf(c), DONE);
  assert.ok(c.closed_at);
});

test("เงียบยังไม่ถึง 24 ชม.: ไม่ย้าย", async () => {
  const c = quietChat({ last_message_at: ago(23) });
  assert.equal(await autoCloseQuietChats(NOW), 0);
  assert.deepEqual(tabsOf(c), ALL);
});

test("ลูกค้าพิมพ์ล่าสุด: ไม่ย้าย แม้นานแค่ไหน", async () => {
  const c = quietChat({ last_direction: "in", last_message_at: ago(500) });
  assert.equal(await autoCloseQuietChats(NOW), 0);
  assert.deepEqual(tabsOf(c), WAITING);
});

for (const tag of ["ตามต่อ", "รอนัด"]) {
  test(`แท็ก ${tag}: ไม่ย้าย`, async () => {
    const c = quietChat({ tags: ["วัคซีน", tag] });
    assert.equal(await autoCloseQuietChats(NOW), 0);
    assert.deepEqual(tabsOf(c), ALL);
  });
}

for (const tag of ["นัดแล้ว", "ร้องเรียน", "วัคซีน"]) {
  test(`แท็ก ${tag}: ย้ายตามปกติ`, async () => {
    const c = quietChat({ tags: [tag] });
    assert.equal(await autoCloseQuietChats(NOW), 1);
    assert.deepEqual(tabsOf(c), DONE);
    assert.deepEqual(c.tags, [tag], "ไม่แตะแท็ก");
  });
}

test("ต้องให้คนตอบ: ไม่ย้าย", async () => {
  const c = quietChat({ needs_human: true });
  assert.equal(await autoCloseQuietChats(NOW), 0);
  assert.deepEqual(tabsOf(c), ALL);
});

test("เพิ่งกดเปิดใหม่: ไม่ถูกปิดซ้ำทันที จนกว่าจะเงียบครบอีกรอบ", async () => {
  const c = quietChat({ last_message_at: ago(500), reopened_at: ago(1) });
  assert.equal(await autoCloseQuietChats(NOW), 0);
  c.reopened_at = ago(25);
  assert.equal(await autoCloseQuietChats(NOW), 1);
});

test("แชทที่เสร็จแล้ว: closed_at เดิมไม่ถูกแตะ", async () => {
  const c = quietChat({ status: "closed", closed_at: ago(100) });
  const before = c.closed_at;
  assert.equal(await autoCloseQuietChats(NOW), 0);
  assert.equal(c.closed_at, before);
});

test("ตั้ง 0 = ปิด", async () => {
  setup("off", [{ key: "auto_close_hours", value: 0 }]);
  const c = quietChat({ last_message_at: ago(9000) });
  assert.equal(await autoCloseQuietChats(NOW), 0);
  assert.deepEqual(tabsOf(c), ALL);
});

test("ตั้ง N ชั่วโมงเองได้", async () => {
  setup("off", [{ key: "auto_close_hours", value: 48 }]);
  const young = quietChat({ last_message_at: ago(47) });
  const old = quietChat({ last_message_at: ago(49) });
  assert.equal(await autoCloseQuietChats(NOW), 1);
  assert.deepEqual(tabsOf(young), ALL);
  assert.deepEqual(tabsOf(old), DONE);
});

test("ค่าตั้งเสีย: ใช้ 24 ไม่ปิดทุกแชท", () => {
  assert.equal(DEFAULT_AUTO_CLOSE_HOURS, 24);
  for (const bad of [-1, "abc", null, undefined, Infinity]) assert.equal(normalizeAutoCloseHours(bad), 24, String(bad));
  assert.equal(normalizeAutoCloseHours(0), 0);
  assert.equal(normalizeAutoCloseHours("48"), 48);
});

test("ย้ายอัตโนมัติแล้วลูกค้าทักกลับ: กลับเข้ารอตอบ", async () => {
  const s = await customer();
  await staffReply(s.conversationId);
  conv().last_message_at = ago(25);
  assert.equal(await autoCloseQuietChats(NOW), 1);
  assert.deepEqual(tabs(), DONE);
  await customer("สอบถามเพิ่มค่ะ");
  assert.deepEqual(tabs(), WAITING);
});

// ---- แชทถัดไปหลังกดเสร็จแล้ว ----
test("แชทถัดไปมาจากแท็บรอตอบเท่านั้น", () => {
  const waiting = [{ id: "a", status: "open" }, { id: "b", status: "open" }];
  assert.equal(nextOpenChat(waiting, "a"), "b");
  assert.equal(nextOpenChat(waiting, "z"), "a", "กดจากแท็บทั้งหมดด้วยแชทที่ไม่อยู่ในคิว เริ่มจากต้นคิว");
  assert.equal(nextOpenChat([], "a"), null);
});
