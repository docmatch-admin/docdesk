// ทดสอบการย้ายแท็บ inbox ด้วยโค้ดจริงของ pipeline: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import sharp from "sharp";
import { fake } from "./fakes/hooks.mjs";

const { replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const {
  aiTiming, autoCloseQuietChats, markConversationRead, processIncoming, sendMediaReply, sendReply, setConversationTag, storeIncoming,
} = await import("../src/lib/pipeline.ts");
const { CLOSE_PATCH, DEFAULT_AUTO_CLOSE_HOURS, inboxOrder, nextOpenChat, normalizeAutoCloseHours, tabsOf } = await import("../src/lib/case-flow.ts");

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

// ---- รายการแชทรวม (ไม่มีแท็บเสร็จแล้ว) ----
test("รายการรวม: รอตอบอยู่บนสุด รอนานสุดอยู่บน · ที่เหลือรวมแชทเสร็จแล้วเรียงตามข้อความล่าสุด · ปุ่มกรองรอตอบ", () => {
  const t = (m) => new Date(Date.parse("2026-11-18T10:00:00Z") - m * 60_000).toISOString();
  const rows = [
    { id: "replied", status: "open", last_direction: "out", last_message_at: t(1) },
    { id: "wait5", status: "open", last_direction: "in", waiting_since: t(5), last_message_at: t(5) },
    { id: "done-new", status: "closed", last_direction: "out", last_message_at: t(2) },
    { id: "wait40", status: "open", last_direction: "in", waiting_since: t(40), last_message_at: t(40) },
    { id: "booking", status: "open", last_direction: "out", booking_pending: true, last_message_at: t(3) },
    { id: "done-old", status: "closed", last_direction: "in", last_message_at: t(90) },
    { id: "wait5", status: "open", last_direction: "in", waiting_since: t(5), last_message_at: t(5) },
  ];
  assert.deepEqual(inboxOrder(rows).map((r) => r.id), ["wait40", "wait5", "booking", "replied", "done-new", "done-old"],
    "รอนานสุดบนสุด · รอเพราะนัดต่อท้ายชั้นบน · ชั้นล่างเรียงข้อความล่าสุด รวมเสร็จแล้ว · ไม่ซ้ำ");
  assert.deepEqual(inboxOrder(rows, { onlyWaiting: true }).map((r) => r.id), ["wait40", "wait5", "booking"]);
});

test("กดเสร็จแล้ว: แชทไม่หายจากรายการ แค่ลงชั้นล่าง · ลูกค้าทักใหม่กลับขึ้นชั้นรอตอบ", async () => {
  const s = await customer();
  assert.deepEqual(inboxOrder(state.tables.conversations).map((c) => c.id), [s.conversationId]);
  await closeViaDb();
  const after = inboxOrder(state.tables.conversations);
  assert.deepEqual(after.map((c) => c.id), [s.conversationId], "ยังอยู่ในรายการ");
  assert.equal(after[0].status, "closed");
  assert.equal(inboxOrder(state.tables.conversations, { onlyWaiting: true }).length, 0);
  await customer("ขอสอบถามเพิ่มค่ะ");
  assert.deepEqual(tabs(), WAITING, "เปิดเองแล้วอยู่ชั้นรอตอบ");
  assert.deepEqual(inboxOrder(state.tables.conversations, { onlyWaiting: true }).map((c) => c.id), [s.conversationId]);
});

// ---- รายการแชทแบบคิวงาน: 3 ช่วง รอตอบ / งานค้าง / ล่าสุด ----
const flow = await import("../src/lib/case-flow.ts");
const { inboxWork, inboxCounts } = await import("../src/lib/inbox-work.ts");

test("คิวงาน: จัดช่วง + เรียง (รอตอบ รอนานสุดบน · งานค้าง งานเก่าสุดก่อน · ล่าสุด ข้อความล่าสุดก่อน รวมเสร็จแล้ว) · ปุ่มกรอง", () => {
  const t = (m) => new Date(Date.parse("2026-11-18T10:00:00Z") - m * 60_000).toISOString();
  const rows = [
    { id: "w3", status: "open", last_direction: "in", waiting_since: t(3), last_message_at: t(3), assigned_to: "me" },
    { id: "w20", status: "open", last_direction: "in", waiting_since: t(20), last_message_at: t(20) },
    { id: "task", status: "open", last_direction: "out", last_message_at: t(1), assigned_to: "me" },
    { id: "booking", status: "open", last_direction: "out", last_message_at: t(2) },
    { id: "replied", status: "open", last_direction: "out", last_message_at: t(4) },
    { id: "done", status: "closed", last_direction: "out", last_message_at: t(2), assigned_to: "me" },
    { id: "done-failed", status: "closed", last_direction: "out", last_message_at: t(9) },
  ];
  const work = {
    task: [{ kind: "tasks", since: t(30), count: 2 }],
    booking: [{ kind: "ai_review", since: t(5) }, { kind: "booking", since: t(60) }],
    "done-failed": [{ kind: "failed", since: t(10) }],
  };
  const s = flow.inboxSections(rows, work);
  assert.deepEqual(s.waiting.map((r) => r.id), ["w20", "w3"]);
  assert.deepEqual(s.work.map((r) => r.id), ["booking", "task", "done-failed"], "งานเก่าสุดก่อน");
  assert.deepEqual(s.recent.map((r) => r.id), ["done", "replied"], "เสร็จแล้วอยู่ช่วงล่าสุด เรียงข้อความล่าสุด");
  // รอตอบมาก่อนงานค้างเสมอ แม้มีงาน
  assert.equal(flow.sectionOf({ status: "open", last_direction: "in" }, [{ kind: "booking", since: t(1) }]), "waiting");
  // ป้าย: งานด่วนสุด
  assert.equal(flow.workLabel(flow.topWork(work.booking)), "ยืนยันนัด");
  assert.equal(flow.workLabel(flow.topWork(work.task)), "งานทีม 2");
  assert.equal(flow.workLabel({ kind: "reschedule", since: t(1) }), "ขอเลื่อนนัด");
  assert.equal(flow.workLabel({ kind: "failed", since: t(1) }), "ส่งไม่สำเร็จ");
  assert.equal(flow.workLabel({ kind: "ai_review", since: t(1) }), "AI ตอบแล้ว รอตรวจ");
  // ปุ่มกรอง
  assert.deepEqual(flow.inboxSections(rows, work, { filter: "waiting" }).work, []);
  assert.deepEqual(flow.inboxSections(rows, work, { filter: "work" }).waiting, []);
  const mine = flow.inboxSections(rows, work, { filter: "mine", meId: "me" });
  assert.deepEqual([...mine.waiting, ...mine.work, ...mine.recent].map((r) => r.id), ["w3", "task", "done"], "ของฉัน = มอบหมายให้ฉัน ทั้ง 3 ช่วง");
  const un = flow.inboxSections(rows, work, { filter: "unassigned" });
  assert.ok([...un.waiting, ...un.work, ...un.recent].every((r) => !r.assigned_to), "ยังไม่มีคนรับ = ไม่มีผู้ดูแล");
  // ป้ายเวลารอ: <5 เทา · 5–15 เหลือง · >15 แดง
  assert.equal(flow.waitBadge(t(4), Date.parse("2026-11-18T10:00:00Z")).level, "normal");
  assert.equal(flow.waitBadge(t(5), Date.parse("2026-11-18T10:00:00Z")).level, "warn");
  assert.equal(flow.waitBadge(t(16), Date.parse("2026-11-18T10:00:00Z")).level, "late");
});

test("คิวงาน: กดเสร็จแล้วลงช่วงล่าสุด (ไม่หาย) · ลูกค้าทักใหม่ขึ้นรอตอบ", async () => {
  const s = await customer();
  assert.equal(flow.sectionOf(conv(), undefined), "waiting");
  await closeViaDb();
  assert.deepEqual(flow.inboxSections(state.tables.conversations, {}).recent.map((c) => c.id), [s.conversationId]);
  await customer("ขอถามอีกนิดค่ะ");
  assert.deepEqual(flow.inboxSections(state.tables.conversations, {}).waiting.map((c) => c.id), [s.conversationId]);
});

test("งานค้างจากฐานข้อมูล: ยืนยันนัด · ขอเลื่อนนัด · ส่งไม่สำเร็จ (นัด/ผลแล็บ) · งานทีม · AI ตอบแล้ว รอตรวจ + badge เมนู", async () => {
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  resetDb({
    conversations: [
      { id: "c-book", status: "open", last_direction: "out", archived: false },
      { id: "c-res", status: "open", last_direction: "out", archived: false },
      { id: "c-fail", status: "closed", last_direction: "out", archived: false },
      { id: "c-lab", status: "open", last_direction: "out", archived: false },
      { id: "c-task", status: "open", last_direction: "out", archived: false },
      { id: "c-ai", status: "open", last_direction: "out", archived: false, ai_review_at: "2026-11-18T03:00:00Z" },
      { id: "c-wait", status: "open", last_direction: "in", archived: false },
      { id: "c-none", status: "open", last_direction: "out", archived: false },
    ],
    bookings: [{ conversation_id: "c-book", status: "ai_confirmed", created_at: "2026-11-18T01:00:00Z", date: "2026-11-20", time: "09:00:00" }, { conversation_id: "c-none", status: "recorded", created_at: "2026-11-18T01:00:00Z" }],
    appointments: [
      { hn: "000000111", conversation_id: null, status: "reschedule_requested", appoint_date: day, called_at: null, last_send_error: null, updated_at: "2026-11-18T02:00:00Z", reschedule_request: { date: "2026-11-25" } },
      { hn: null, conversation_id: "c-fail", status: "scheduled", appoint_date: day, called_at: null, last_send_error: "ส่งไม่ได้", updated_at: "2026-11-18T02:00:00Z" },
      { hn: null, conversation_id: "c-none", status: "scheduled", appoint_date: day, called_at: null, last_send_error: null, updated_at: "2026-11-18T02:00:00Z" },
    ],
    patient_links: [{ conversation_id: "c-res", hn: "000000111" }, { conversation_id: "c-lab", hn: "000000222" }],
    lab_results: [{ patient_id: "000000222", notify_status: "failed", updated_at: "2026-11-18T02:30:00Z" }],
    chat_tasks: [{ conversation_id: "c-task", done: false, created_at: "2026-11-18T00:30:00Z" }, { conversation_id: "c-task", done: false, created_at: "2026-11-18T00:40:00Z" }, { conversation_id: "c-none", done: true, created_at: "2026-11-18T00:30:00Z" }],
  });
  const w = await inboxWork();
  const kinds = (id) => (w[id] ?? []).map((i) => i.kind);
  assert.deepEqual(kinds("c-book"), ["booking"]);
  assert.deepEqual(kinds("c-res"), ["reschedule"]);
  assert.equal(flow.workLabel(w["c-book"][0]), "ยืนยันนัด 20 พ.ย. 09:00");
  assert.equal(flow.workLabel(w["c-res"][0]), "ขอเลื่อนนัด → 25 พ.ย.");
  assert.deepEqual(kinds("c-fail"), ["failed"]);
  assert.deepEqual(kinds("c-lab"), ["failed"]);
  assert.deepEqual(w["c-task"], [{ kind: "tasks", since: "2026-11-18T00:30:00Z", count: 2 }]);
  assert.deepEqual(kinds("c-ai"), ["ai_review"]);
  assert.equal(w["c-none"], undefined);
  assert.deepEqual(await inboxCounts(), { waiting: 1, work: 6, total: 7 });
});

test("AI ตอบเอง → งานค้าง \"AI ตอบแล้ว รอตรวจ\" · เจ้าหน้าที่เปิดแชท → หายจากงานค้าง", async () => {
  setup("auto");
  replies.next = aiReply(0.9);
  const s = await customer("วัคซีนราคาเท่าไหร่");
  await processIncoming(s.conversationId, s.messageId);
  assert.ok(conv().ai_review_at, "AI ตอบแล้วตั้ง ai_review_at");
  assert.equal(flow.sectionOf(conv(), (await inboxWork())[s.conversationId]), "work");
  const read = await import("../src/app/api/conversations/[id]/read/route.ts");
  state.tables.staff = [{ id: "s1", role: "agent", active: true, display_name: "เอ", must_change_password: false }];
  state.currentUser = { id: "s1" };
  await read.POST(new Request("https://app.test/x", { method: "POST" }), { params: Promise.resolve({ id: s.conversationId }) });
  assert.equal(conv().ai_review_at, null);
  assert.equal(flow.sectionOf(conv(), (await inboxWork())[s.conversationId]), "recent");
});

test("ป้ายงานค้างมีวันเวลา: ยืนยันนัด <วัน เวลา> · ขอเลื่อนนัด → <วัน>", () => {
  assert.equal(flow.workLabel({ kind: "booking", since: "x", date: "2026-11-19", time: "10:30" }), "ยืนยันนัด 19 พ.ย. 10:30");
  assert.equal(flow.workLabel({ kind: "reschedule", since: "x", date: "2026-12-02" }), "ขอเลื่อนนัด → 2 ธ.ค.");
  assert.equal(flow.workLabel({ kind: "booking", since: "x" }), "ยืนยันนัด");
});

test("เปิดแชท = request เดียว: GET /api/conversations/[id] ได้ข้อความ นัดรอลง งาน/คอมเมนต์ ใครติดแท็ก + Server-Timing · แชทลับไม่ส่งข้อความ", async () => {
  const s = await customer("ขอนัดค่ะ");
  state.tables.staff = [{ id: "s1", role: "admin", active: true, display_name: "เอ", must_change_password: false, can_view_sensitive: true }];
  state.currentUser = { id: "s1" };
  state.tables.bookings = [{ id: "b1", conversation_id: s.conversationId, status: "ai_confirmed", date: "2026-11-20", time: "09:00", service: "ตรวจ" }];
  state.tables.chat_tasks = [{ id: "t1", conversation_id: s.conversationId, text: "โทรกลับ", done: false, created_at: nextTime() }];
  state.tables.chat_notes = [];
  state.tables.assignment_log = [];
  state.tables.tag_events = [{ conversation_id: s.conversationId, tag: "นัด", action: "add", by: "ai", created_at: nextTime() }];
  const route = await import("../src/app/api/conversations/[id]/route.ts");
  const get = () => route.GET(new Request("https://app.test/x"), { params: Promise.resolve({ id: s.conversationId }) });
  const res = await get();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Server-Timing") ?? "", /auth;dur=.*total;dur=/);
  const j = await res.json();
  assert.ok(!j.conv.sensitive);
  assert.deepEqual(j.messages.map((m) => m.body), ["ขอนัดค่ะ"]);
  assert.deepEqual(j.bookings.map((b) => b.id), ["b1"]);
  assert.deepEqual(j.tasks.map((t) => t.id), ["t1"]);
  assert.deepEqual(j.tagSources, { "นัด": "ai" });

  conv().sensitive = true;
  assert.equal((await (await get()).json()).messages, null, "แชทลับต้องเปิดผ่าน /messages (บันทึกประวัติการเปิด)");
});

test("เปิดอ่านแชท: server ล้างตัวเลขยังไม่อ่านให้ (หน้าเว็บไม่ต้องยิงแยก) · /api/inbox/work ให้งานค้าง + ตัวเลข badge ใน request เดียว", async () => {
  const s = await customer("สวัสดีค่ะ");
  assert.ok(conv().unread_count > 0);
  state.tables.staff = [{ id: "s1", role: "agent", active: true, display_name: "เอ", must_change_password: false }];
  state.currentUser = { id: "s1" };
  const read = await import("../src/app/api/conversations/[id]/read/route.ts");
  await read.POST(new Request("https://app.test/x", { method: "POST" }), { params: Promise.resolve({ id: s.conversationId }) });
  assert.equal(conv().unread_count, 0);

  conv().archived = false;
  const work = await import("../src/app/api/inbox/work/route.ts");
  const res = await work.GET(new Request("https://app.test/api/inbox/work"));
  const j = await res.json();
  assert.ok(j.work && typeof j.work === "object");
  assert.deepEqual(j.counts, { waiting: 1, work: 0, total: 1 });
  assert.match(res.headers.get("Server-Timing") ?? "", /work;dur=/);
});

test("หน้าแชทไม่ยิงซ้ำ: realtime แก้เฉพาะแถว · badge ใช้ผลเดียวกับรายการแชท · layout ไม่คำนวณ badge ทุกครั้งที่เปลี่ยนหน้า", async () => {
  const { readFileSync } = await import("node:fs");
  const inbox = readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8");
  const badge = readFileSync("src/app/(staff)/chat-badge.tsx", "utf8");
  const layout = readFileSync("src/app/(staff)/layout.tsx", "utf8");
  assert.match(inbox, /useChatCountsOwner\(\)/);
  assert.match(inbox, /publishChatCounts\(/);
  assert.match(inbox, /chatBundle\(selectedId\)/);
  assert.doesNotMatch(inbox, /update\(\{ unread_count: 0 \}\)/, "ล้าง unread ที่ server ใน /read แล้ว");
  assert.match(badge, /if \(owners > 0 \|\| inflight\) return;/);
  assert.match(badge, /DEBOUNCE_MS = 2_000/);
  assert.doesNotMatch(layout, /inboxCounts/);
  for (const f of ["appointments-block", "team-panel", "lab-results-block", "archive-merge-bar"]) {
    assert.match(readFileSync(`src/app/(staff)/inbox/${f}.tsx`, "utf8"), /chatBundle\(conversationId\)/, f);
  }
});

// ---------------------------------------------------------------------------
// รอบ 2: /api/inbox/list (server ดึงครั้งเดียว ทีละหน้า) + migration 063
// ---------------------------------------------------------------------------
const list = await import("../src/lib/inbox-list.ts");
const listRoute = await import("../src/app/api/inbox/list/route.ts");
function queueDb(rows) {
  resetDb({
    staff: [{ id: "me", role: "agent", active: true, display_name: "ฉัน", must_change_password: false }],
    conversations: rows.map((r) => ({ archived: false, tags: [], status: "open", ...r })),
    bookings: [], appointments: [], lab_results: [], chat_tasks: [], patient_links: [],
  });
  state.currentUser = { id: "me" };
}
const getList = async (qs) => (await listRoute.GET(new Request(`https://app.test/api/inbox/list?${qs}`))).json();

test("queueSections: ช่วงจากแถว (รอตอบตัดสินจากแถวเอง · ตอบแล้วยังไม่รู้งาน = ล่าสุด) + เรียงเหมือนเดิม + ของฉัน", () => {
  const rows = [
    { id: "w2", status: "open", last_direction: "in", waiting_since: "2026-11-19T02:00:00Z", queue: "waiting" },
    { id: "w1", status: "open", last_direction: "in", waiting_since: "2026-11-19T01:00:00Z", queue: "waiting" },
    { id: "k2", status: "open", last_direction: "out", work_since: "2026-11-18T02:00:00Z", queue: "work", assigned_to: "me" },
    { id: "k1", status: "closed", last_direction: "out", work_since: "2026-11-18T01:00:00Z", queue: "work" },
    { id: "r1", status: "closed", last_direction: "out", last_message_at: "2026-11-19T03:00:00Z", queue: "recent" },
    // เพิ่งตอบในเครื่องนี้ (server ยังไม่บอกช่วงใหม่)
    { id: "x", status: "open", last_direction: "out", last_message_at: "2026-11-19T04:00:00Z", queue: "waiting" },
  ];
  const s = flow.queueSections(rows);
  assert.deepEqual(s.waiting.map((r) => r.id), ["w1", "w2"]);
  assert.deepEqual(s.work.map((r) => r.id), ["k1", "k2"]);
  assert.deepEqual(s.recent.map((r) => r.id), ["x", "r1"]);
  assert.deepEqual(flow.queueSections(rows, { filter: "mine", meId: "me" }).work.map((r) => r.id), ["k2"]);
  assert.deepEqual(flow.queueSections(rows, { filter: "unassigned" }).work.map((r) => r.id), ["k1"]);
  assert.deepEqual(flow.queueSections(rows, { filter: "waiting" }).recent, []);
});

test("/api/inbox/list (มี migration 063): ทีละหน้า ข้ามช่วง รอตอบ → งานค้าง → ล่าสุด · ตัวเลข/badge · แถวเดียวด้วย id · Server-Timing", async () => {
  queueDb([
    { id: "w1", last_direction: "in", queue: "waiting", sort_key: "2026-11-19T01:00:00Z" },
    { id: "w2", last_direction: "in", queue: "waiting", sort_key: "2026-11-19T02:00:00Z" },
    { id: "k1", last_direction: "out", queue: "work", work_kind: "booking", work_label: "ยืนยันนัด 20 พ.ย. 09:00", sort_key: "2026-11-18T01:00:00Z", assigned_to: "me" },
    { id: "r1", status: "closed", last_direction: "out", queue: "recent", sort_key: "2026-11-19T05:00:00Z" },
    { id: "r2", status: "closed", last_direction: "out", queue: "recent", sort_key: "2026-11-19T04:00:00Z", archived: true },
  ]);
  list.resetInboxListCache(true);
  const p1 = await getList("limit=3");
  assert.equal(p1.mode, "queue");
  assert.deepEqual(p1.rows.map((r) => r.id), ["w1", "w2", "k1"]);
  assert.equal(p1.rows[2].work_label, "ยืนยันนัด 20 พ.ย. 09:00");
  assert.equal(p1.next, "recent:0");
  assert.deepEqual(p1.counts, { waiting: 2, work: 1, mine: 1, unassigned: 2 }, "ของฉัน/ยังไม่มีคนรับ = แชทที่ต้องทำ (รอตอบ+งานค้าง)");
  const un = await getList("filter=unassigned");
  assert.deepEqual(un.rows.map((r) => r.id), ["w1", "w2", "r1", "r2"], "ยังไม่มีคนรับ = ไม่มีผู้ดูแล ทั้ง 3 ช่วง");
  assert.deepEqual(p1.badge, { waiting: 2, work: 1, total: 3 });
  const p2 = await getList(`limit=3&cursor=${p1.next}`);
  assert.deepEqual(p2.rows.map((r) => r.id), ["r1", "r2"], "แชทเก่าที่ปิดแล้วอยู่ช่วงล่าสุด");
  assert.equal(p2.next, null);
  const p3 = await getList("limit=1&cursor=waiting:1");
  assert.deepEqual(p3.rows.map((r) => r.id), ["w2"]);
  assert.equal(p3.next, "work:0");
  assert.deepEqual((await getList("filter=work")).rows.map((r) => r.id), ["k1"]);
  assert.deepEqual((await getList("filter=mine")).rows.map((r) => r.id), ["k1"]);
  assert.deepEqual((await getList("id=r1")).rows.map((r) => r.id), ["r1"]);
  const res = await listRoute.GET(new Request("https://app.test/api/inbox/list"));
  const timing = res.headers.get("Server-Timing") ?? "";
  for (const k of ["auth", "rows", "counts", "total"]) assert.match(timing, new RegExp(`${k};dur=`), k);
  list.resetInboxListCache();
});

test("/api/inbox/list (ยังไม่ได้รัน 063): คำนวณกติกาเดิมที่ server ใน request เดียว · แถวบอกช่วง + ป้ายงานค้าง", async () => {
  queueDb([
    { id: "w1", last_direction: "in", waiting_since: "2026-11-19T01:00:00Z", last_message_at: "2026-11-19T01:00:00Z" },
    { id: "k1", last_direction: "out", last_message_at: "2026-11-19T02:00:00Z" },
    { id: "r1", status: "closed", last_direction: "out", last_message_at: "2026-11-19T03:00:00Z" },
  ]);
  state.tables.bookings = [{ conversation_id: "k1", status: "ai_confirmed", created_at: "2026-11-18T00:00:00Z", date: "2026-11-20", time: "09:00:00" }];
  list.resetInboxListCache(false);
  const j = await getList("limit=2");
  assert.equal(j.mode, "compute");
  assert.deepEqual(j.rows.map((r) => [r.id, r.queue]), [["w1", "waiting"], ["k1", "work"]]);
  assert.equal(j.rows[1].work_label, "ยืนยันนัด 20 พ.ย. 09:00");
  assert.equal(j.next, "recent:0");
  assert.deepEqual(j.counts, { waiting: 1, work: 1, mine: 0, unassigned: 2 });
  assert.deepEqual((await getList(`cursor=${j.next}`)).rows.map((r) => r.id), ["r1"]);
  list.resetInboxListCache();
});

test("migration 063: คอลัมน์ queue + trigger ทุกตารางที่เป็นที่มาของงานค้าง + index + ป้ายเหมือน workLabel + ค้นหาใช้ trigram", async () => {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync("supabase/migrations/063_inbox_queue_columns.sql", "utf8");
  for (const col of ["queue", "work_kind", "work_label", "work_since", "sort_key", "ai_review_at"]) {
    assert.match(sql, new RegExp(`add column if not exists ${col} `), col);
  }
  for (const t of ["bookings", "chat_tasks", "patient_links", "appointments", "lab_results"]) {
    assert.match(sql, new RegExp(`create trigger ${t}_queue after insert or delete or update`), t);
  }
  assert.match(sql, /create trigger conversations_queue_upd before update on conversations/);
  assert.match(sql, /conversations \(queue, sort_key, id\)/);
  assert.match(sql, /where queue = 'waiting'/);
  assert.match(sql, /where queue = 'work'/);
  // ป้ายเหมือนหน้าเว็บ (case-flow.workLabel)
  for (const label of ["'ยืนยันนัด'", "'ขอเลื่อนนัด'", "' → '", "'ส่งไม่สำเร็จ'", "'งานทีม '", "'AI ตอบแล้ว รอตรวจ'"]) assert.ok(sql.includes(label), label);
  assert.match(sql, /'ม\.ค\.','ก\.พ\.'.*'พ\.ย\.','ธ\.ค\.'/);
  assert.match(sql, /gin_trgm_ops/);
  assert.match(sql, /hits as \(/);
  assert.match(sql, /update conversations set queue_touch_at = now\(\);/, "backfill");
});

test("กล่องคำตอบแนะนำ: หัวข้อบรรทัดเดียว พับได้ และ 'ส่งตามที่พิมพ์' อยู่ที่หัวข้อ", () => {
  const src = readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8");
  const head = src.slice(src.indexOf('<div className="suggest-head">'), src.indexOf('<div className="sugg-list">'));
  assert.match(head, /className="suggest-toggle" aria-expanded=\{suggestOpen\}/, "ปุ่มพับอยู่ซ้ายสุดของหัวข้อ");
  assert.match(head, /ส่งตามที่พิมพ์ <\/span>\(ไม่แปล\)/, "ติ๊กไม่แปลย้ายมาที่หัวข้อ (มือถือเหลือ \"(ไม่แปล)\")");
  assert.match(head, /suggestion\?\.needs_human &&/, "คำเตือนเรื่องอาการแสดงแม้พับ");
  assert.match(src, /\{suggestOpen && <div className="sugg-list">/, "พับแล้วซ่อนรายการคำตอบ");
  const foot = src.slice(src.indexOf('<div className="composer-foot">'));
  assert.doesNotMatch(foot.slice(0, 800), /ส่งตามที่พิมพ์/, "ไม่ซ้ำที่ด้านล่าง");
});

test("กล่องข้อมูลลูกค้า: แสดงเฉพาะข้อมูลที่มี ไม่มีช่องว่าง/ข้อมูล HIS ที่ยังไม่เชื่อม", () => {
  const card = readFileSync("src/app/(staff)/inbox/customer-card.tsx", "utf8");
  assert.match(card, /\{hn && /, "ไม่ผูก HN = ไม่มีบรรทัด HN");
  assert.match(card, /\{phone && /, "ไม่มีเบอร์ = ไม่มีบรรทัดเบอร์");
  assert.doesNotMatch(card, /แพ้ยา/, "แพ้ยายังดึงจาก HIS ไม่ได้ ไม่โชว์");
  assert.match(card, /\{hn && facts\?\.rights && /, "สิทธิแสดงเมื่อมีจากการมาตรวจเท่านั้น");
  const vh = readFileSync("src/app/(staff)/inbox/visit-history.tsx", "utf8");
  assert.match(vh, /if \(!history \|\| !history\.visits\.length\) return null;/, "ไม่มีประวัติ = ไม่แสดงกล่อง");
  const inbox = readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8");
  assert.match(inbox, /<h2 className="cust-title">ข้อมูลลูกค้า<\/h2>\s*<CustomerCard /, "ข้อมูลลูกค้าอยู่บนสุดของแผงขวา");
  const mc = readFileSync("src/app/(staff)/inbox/mobile-chat.tsx", "utf8");
  assert.match(mc, /linked\.find\(\(g\) => g\.primary\)/, "คนไข้หลัก = HN ที่ตั้งเป็นหลักก่อน");
});

test("066: สิทธิ/วินิจฉัย/อายุ ใน his_visit_cache อ่านตรงด้วย login เจ้าหน้าที่ไม่ได้ (ต้องผ่าน API ที่กันแชทลับ)", () => {
  const sql = readFileSync("supabase/migrations/066_visit_history.sql", "utf8");
  assert.match(sql, /revoke select on his_visit_cache from authenticated;/);
  const grant = sql.match(/grant select \(([^)]+)\) on his_visit_cache to authenticated;/);
  assert.ok(grant, "ให้สิทธิ์อ่านเฉพาะคอลัมน์เดิม");
  assert.doesNotMatch(grant[1], /rights|diagnosis|age_y/);
  const route = readFileSync("src/app/api/conversations/[id]/visits/route.ts", "utf8");
  assert.match(route, /denySensitiveChat\(id, canViewSensitive\)/);
});
