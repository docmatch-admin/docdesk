// ทดสอบแชทลับ ใช้ข้อมูลจำลองเท่านั้น RLS จริงทดสอบแยกบน production: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { aiTiming, processIncoming, sendReply, starMessage, storeIncoming, tryAutoSend } = await import("../src/lib/pipeline.ts");
const { generateSuggestions } = await import("../src/lib/suggest.ts");
const { applySensitiveGuard, DEFAULT_SENSITIVE_KEYWORDS, matchSensitive, normalizeSensitiveKeywords, SENSITIVE_ACK_TEXT, tagLabel } = await import("../src/lib/sensitive-rules.ts");
const { markConversationSensitive, notifySensitiveChat } = await import("../src/lib/sensitive-store.ts");
const { pushPendingBookings } = await import("../src/lib/booking-store.ts");
const { purgeExpiredMedia } = await import("../src/lib/media-store.ts");
const { buildTagCsv } = await import("../src/lib/tags.ts");
const { importRoom } = await import("../src/lib/line-import-store.ts");
const messagesRoute = await import("../src/app/api/conversations/[id]/messages/route.ts");
const sensitiveRoute = await import("../src/app/api/conversations/[id]/sensitive/route.ts");
const suggestRoute = await import("../src/app/api/conversations/[id]/suggest/route.ts");
const sendRoute = await import("../src/app/api/conversations/[id]/send/route.ts");
const sendMediaRoute = await import("../src/app/api/conversations/[id]/send-media/route.ts");
const closeRoute = await import("../src/app/api/conversations/[id]/close/route.ts");
const tagsRoute = await import("../src/app/api/conversations/[id]/tags/route.ts");
const assignRoute = await import("../src/app/api/conversations/[id]/assign/route.ts");
const readRoute = await import("../src/app/api/conversations/[id]/read/route.ts");
const starRoute = await import("../src/app/api/messages/[id]/star/route.ts");
const bookingRoute = await import("../src/app/api/bookings/[id]/route.ts");
const recordRoute = await import("../src/app/api/bookings/[id]/record/route.ts");
const draftRoute = await import("../src/app/api/bookings/[id]/draft/route.ts");
const ackRoute = await import("../src/app/api/account/sensitive-ack/route.ts");
const exportRoute = await import("../src/app/api/examples/export/route.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const KW = DEFAULT_SENSITIVE_KEYWORDS;
const ADMIN = { id: "admin", email: "a@test" };
const ALLOWED = { id: "allowed", email: "b@test" };
const DENIED = { id: "denied", email: "c@test" };

function setup(mode = "off") {
  reset();
  aiTiming.debounceMs = 0;
  resetDb({
    settings: [{ key: "ai_mode", value: mode }, { key: "business_hours", value: { tz: "Asia/Bangkok", days: {} } }],
    channels: [{ id: "ch", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [], conversations: [], tags: [{ id: "t", name: "STD", active: true }], tag_rules: [], tag_events: [], reply_examples: [],
    knowledge_items: [], lab_items: [], lab_packages: [], bookings: [], push_subscriptions: [], sensitive_access_log: [],
    staff: [
      { id: "admin", role: "admin", active: true, display_name: "A" },
      { id: "allowed", role: "agent", active: true, display_name: "B", can_view_sensitive: true },
      { id: "denied", role: "agent", active: true, display_name: "C", can_view_sensitive: false },
    ],
  });
  state.currentUser = ADMIN;
  replies.next = { needs_human: false, suggested_tags: [], options: [{ text: "ร่างจาก AI ค่ะ", source: "knowledge", ref_ids: [], confidence: 0.95 }] };
}
beforeEach(() => setup());

const incoming = (text) => storeIncoming({ channelType: "web", externalId: SESSION, text });
const conv = () => state.tables.conversations[0];
const out = () => state.tables.messages.filter((m) => m.direction === "out");
const post = (body) => new Request("https://a.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const ctx = (id) => ({ params: Promise.resolve({ id }) });
async function secretChat() {
  const { conversationId, messageId } = await incoming("อยากตรวจ HIV ค่ะ");
  return { conversationId, messageId };
}

// ---- คำสำคัญ ----
for (const text of ["ตรวจ HIV ค่ะ", "hiv ราคาเท่าไหร่", "ขอ prep", "PEP ค่ะ", "ถุงยางแตก", "เป็นเริมค่ะ", "VDRL กี่บาท", "cd4 เท่าไหร่", "มีอะไรกับแฟน"]) {
  test(`คำสำคัญ: ${text}`, () => assert.equal(matchSensitive(text, KW), true));
}
for (const text of ["ขอเริ่มตรวจสุขภาพ", "กิน pepsi ได้ไหม", "preparation", "standard", "เปิดกี่โมง", "วัคซีนไข้หวัดใหญ่"]) {
  test(`ไม่ใช่คำสำคัญ: ${text}`, () => assert.equal(matchSensitive(text, KW), false));
}
test("รายการคำเสียใช้ค่าเริ่มต้น และตัดซ้ำ", () => {
  assert.deepEqual(normalizeSensitiveKeywords(null), KW);
  assert.deepEqual(normalizeSensitiveKeywords([" ก ", "ก", ""]), ["ก"]);
});
test("แท็กภายในแสดงเป็นลับ และ CSV ไม่มีคำว่า STD", () => {
  assert.equal(tagLabel("STD"), "🔒 ลับ");
  assert.equal(tagLabel("วัคซีน"), "วัคซีน");
  const csv = buildTagCsv([{ display_name: "🔒 แชทลับ", channel: "line", tag: "STD", tagged_at: "2026-01-01T00:00:00Z" }]);
  assert.match(csv, /🔒 แชทลับ/);
  assert.doesNotMatch(csv, /STD/);
});

// ---- ติดอัตโนมัติ ----
test("คำสำคัญในข้อความ: ติดแชทลับ แท็ก needs_human ไม่เรียก LLM", async () => {
  const before = calls.chat;
  await secretChat();
  const c = conv();
  assert.equal(c.sensitive, true);
  assert.ok(c.sensitive_since);
  assert.equal(c.sensitive_reason, "คำสำคัญ");
  assert.doesNotMatch(c.sensitive_reason, /HIV/);
  assert.ok(c.tags.includes("STD"));
  assert.equal(c.needs_human, true);
  assert.equal(calls.chat, before);
});

test("คำสำคัญแก้ในการตั้งค่าได้", async () => {
  state.tables.settings.push({ key: "sensitive_keywords", value: ["คำจำลองลับ"] });
  await incoming("ถาม HIV");
  assert.ok(!conv().sensitive);
  await incoming("ถามคำจำลองลับ");
  assert.equal(conv().sensitive, true);
});

test("AI บอก sensitive ใน JSON เดิม: ติดโดยไม่เรียก LLM เพิ่ม และ needs_human", async () => {
  const { conversationId } = await incoming("ปรึกษาเรื่องส่วนตัวจำลอง");
  replies.next.sensitive = true;
  const before = calls.chat;
  const s = await generateSuggestions(conversationId);
  assert.equal(calls.chat, before + 1);
  assert.equal(conv().sensitive, true);
  assert.equal(conv().sensitive_reason, "AI");
  assert.equal(s.needs_human, true);
});

test("ติดแล้วไม่หายเอง: ข้อความใหม่ไม่เกี่ยวยังเป็นแชทลับ", async () => {
  await secretChat();
  await incoming("เปิดกี่โมงคะ");
  assert.equal(conv().sensitive, true);
  assert.equal(conv().needs_human, true);
});

// ---- สิทธิ์ API ----
const guarded = (id, mid) => [
  ["อ่านข้อความ", () => messagesRoute.GET(post(), ctx(id))],
  ["อ่านคำแนะนำ", () => suggestRoute.POST(new Request("https://a.test/x?ensure=1", { method: "POST" }), ctx(id))],
  ["ส่งข้อความ", () => sendRoute.POST(post({ text: "ตอบ" }), ctx(id))],
  ["ส่งรูป", () => sendMediaRoute.POST(post({ quickMediaId: "x" }), ctx(id))],
  ["กดเสร็จแล้ว", () => closeRoute.POST(post(), ctx(id))],
  ["แท็ก", () => tagsRoute.POST(post({ tag: "x", action: "add" }), ctx(id))],
  ["ผู้ดูแล", () => assignRoute.POST(post({ to: "denied" }), ctx(id))],
  ["อ่านแล้ว", () => readRoute.POST(post(), ctx(id))],
  ["กดดาว", () => starRoute.POST(post(), ctx(mid))],
  ["log", () => sensitiveRoute.POST(post({ reveal: true }), ctx(id))],
];
for (const name of ["อ่านข้อความ", "อ่านคำแนะนำ", "ส่งข้อความ", "ส่งรูป", "กดเสร็จแล้ว", "แท็ก", "ผู้ดูแล", "อ่านแล้ว", "กดดาว", "log"]) {
  test(`ไม่มีสิทธิ์ ${name}: 403`, async () => {
    const { conversationId, messageId } = await secretChat();
    state.currentUser = DENIED;
    const res = await guarded(conversationId, messageId).find(([n]) => n === name)[1]();
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "sensitive_forbidden");
  });
}

for (const [name, call] of [
  ["แก้นัด", (id) => bookingRoute.PATCH(post({ name: "ก" }), ctx(id))],
  ["ลงนัด", (id) => recordRoute.POST(post(), ctx(id))],
  ["ร่างขอเลื่อน", (id) => draftRoute.POST(post(), ctx(id))],
]) {
  test(`ไม่มีสิทธิ์ ${name}ของแชทลับ: 403`, async () => {
    const { conversationId } = await secretChat();
    state.tables.bookings.push({ id: "bk", conversation_id: conversationId, status: "ai_confirmed", service: "x", date: "2030-01-03", time: "10:00" });
    state.currentUser = DENIED;
    assert.equal((await call("bk")).status, 403);
  });
}

test("แชทปกติ: คนไม่มีสิทธิ์ใช้ได้ตามเดิม", async () => {
  const { conversationId } = await incoming("เปิดกี่โมงคะ");
  state.currentUser = DENIED;
  assert.equal((await messagesRoute.GET(post(), ctx(conversationId))).status, 200);
});

test("มีสิทธิ์แต่ยังไม่รับทราบ: 428 รับทราบแล้วอ่านได้ และบันทึก open", async () => {
  const { conversationId } = await secretChat();
  state.currentUser = ALLOWED;
  assert.equal((await messagesRoute.GET(post(), ctx(conversationId))).status, 428);
  assert.equal(state.tables.sensitive_access_log.length, 0);
  assert.equal((await ackRoute.POST()).status, 200);
  assert.ok(state.tables.staff.find((s) => s.id === "allowed").sensitive_ack_at);
  const res = await messagesRoute.GET(post(), ctx(conversationId));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).messages.length, 1);
  assert.deepEqual(state.tables.sensitive_access_log.map((l) => [l.staff_id, l.conversation_id, l.action]), [["allowed", conversationId, "open"]]);
});

test("ไม่มีสิทธิ์รับทราบไม่ได้", async () => {
  state.currentUser = DENIED;
  assert.equal((await ackRoute.POST()).status, 403);
});

test("กดแสดง: บันทึก reveal", async () => {
  const { conversationId } = await secretChat();
  await sensitiveRoute.POST(post({ reveal: true }), ctx(conversationId));
  assert.equal(state.tables.sensitive_access_log[0].action, "reveal");
});

test("เอาออก: เฉพาะ admin และบันทึก untag", async () => {
  const { conversationId } = await secretChat();
  state.currentUser = ALLOWED;
  assert.equal((await sensitiveRoute.POST(post({ sensitive: false }), ctx(conversationId))).status, 403);
  assert.equal(conv().sensitive, true);
  assert.equal((await tagsRoute.POST(post({ tag: "STD", action: "remove" }), ctx(conversationId))).status, 403);
  state.currentUser = ADMIN;
  assert.equal((await sensitiveRoute.POST(post({ sensitive: false }), ctx(conversationId))).status, 200);
  assert.equal(conv().sensitive, false);
  assert.ok(!conv().tags.includes("STD"));
  assert.equal(state.tables.sensitive_access_log.at(-1).action, "untag");
});

test("เอาออกแล้วเจอคำสำคัญอีก: ติดใหม่พร้อมแท็ก", async () => {
  const { conversationId } = await secretChat();
  await sensitiveRoute.POST(post({ sensitive: false }), ctx(conversationId));
  await incoming("ถาม HIV อีกครั้ง");
  assert.equal(conv().sensitive, true);
  assert.ok(conv().tags.includes("STD"));
});

test("ส่งต่อให้คนไม่มีสิทธิ์ไม่ได้", async () => {
  const { conversationId } = await secretChat();
  assert.equal((await assignRoute.POST(post({ to: "denied" }), ctx(conversationId))).status, 400);
  assert.equal((await assignRoute.POST(post({ to: "allowed" }), ctx(conversationId))).status, 200);
});

test("กลายเป็นแชทลับ: ถอนผู้ดูแลที่ไม่มีสิทธิ์", async () => {
  const { conversationId } = await incoming("เปิดกี่โมงคะ");
  conv().assigned_to = "denied";
  await markConversationSensitive(conversationId, "เจ้าหน้าที่");
  assert.equal(conv().assigned_to, null);
});

// ---- AI ส่งเอง ----
for (const mode of ["auto", "fallback"]) {
  test(`โหมด ${mode}: AI ไม่ส่งคำตอบ ส่งแค่ข้อความตอบรับครั้งเดียว ไม่เรียก LLM`, async () => {
    setup(mode);
    const { conversationId, messageId } = await secretChat();
    const before = calls.chat;
    await processIncoming(conversationId, messageId);
    assert.equal(calls.chat, before);
    assert.deepEqual(out().map((m) => [m.body, m.sender_type]), [[SENSITIVE_ACK_TEXT, "ai"]]);
    assert.equal(conv().needs_human, true);

    const next = await incoming("ถามเพิ่มอีกหน่อย");
    await processIncoming(conversationId, next.messageId);
    assert.equal(out().length, 1, "ส่งซ้ำไม่ได้จนกว่าเจ้าหน้าที่จะตอบ");
  });
}

test("เจ้าหน้าที่ตอบแล้วลูกค้าทักใหม่: ตอบรับได้อีกครั้ง", async () => {
  setup("auto");
  const { conversationId, messageId } = await secretChat();
  await processIncoming(conversationId, messageId);
  await sendReply({ conversationId, textTh: "ตอบจำลองค่ะ", senderType: "staff", senderId: "allowed" });
  const next = await incoming("ถามเพิ่มอีกหน่อย");
  await processIncoming(conversationId, next.messageId);
  assert.equal(out().filter((m) => m.body === SENSITIVE_ACK_TEXT).length, 2);
});

test("ลูกค้าแค่ขอบคุณ: ไม่ตอบรับ", async () => {
  setup("auto");
  const { conversationId } = await secretChat();
  await sendReply({ conversationId, textTh: "ตอบจำลองค่ะ", senderType: "staff", senderId: "allowed" });
  const next = await incoming("ขอบคุณค่ะ");
  await processIncoming(conversationId, next.messageId);
  assert.equal(out().filter((m) => m.sender_type === "ai").length, 0);
});

for (const mode of ["off", "assist"]) {
  test(`โหมด ${mode}: ไม่ส่งอะไรเลย`, async () => {
    setup(mode);
    const { conversationId, messageId } = await secretChat();
    await processIncoming(conversationId, messageId);
    assert.equal(out().length, 0);
  });
}

test("tryAutoSend โดยตรง แม้ตัวเลือกมั่นใจ 100%: ไม่ส่งคำตอบ AI", async () => {
  setup("auto");
  const { conversationId } = await secretChat();
  await tryAutoSend(conversationId, [{ text: "ผล HIV เป็นลบค่ะ", source: "knowledge", ref_ids: [], confidence: 1 }], false, null);
  assert.deepEqual(out().map((m) => m.body), [SENSITIVE_ACK_TEXT]);
});

test("AI เพิ่งบอกว่าลับ โหมด auto: ส่งแค่ตอบรับ", async () => {
  setup("auto");
  const { conversationId, messageId } = await incoming("ปรึกษาเรื่องส่วนตัวจำลอง");
  replies.next.sensitive = true;
  await processIncoming(conversationId, messageId);
  assert.deepEqual(out().map((m) => m.body), [SENSITIVE_ACK_TEXT]);
});

test("prompt แชทลับมีกฎ และคำต้องห้ามถูกตรวจด้วยโค้ด", async () => {
  const { conversationId } = await secretChat();
  replies.next.options = [{ text: "ผล HIV ของคุณพร้อมแล้วค่ะ", source: "knowledge", ref_ids: [], confidence: 0.95 }];
  const s = await generateSuggestions(conversationId);
  assert.match(calls.lastPrompt, /ห้ามเขียนชื่อโรค ผลตรวจ หรือชื่อยา/);
  assert.equal(s.needs_human, true);
  assert.equal(s.options[0].confidence, 0);
  assert.match(s.options[0].note, /คำเฉพาะเรื่องลับ/);
  assert.equal(applySensitiveGuard({ text: "ผลพร้อมแล้วค่ะ", confidence: 0.9 }, KW).confidence, 0.9);
});

test("แชทลับไม่ใช้เทมเพลตจอง ซึ่งจะมีชื่อบริการ", async () => {
  const { conversationId } = await secretChat();
  replies.next.intent = "booking";
  replies.next.booking = { service: "ตรวจ HIV", date: "2030-01-03", time: "10:00" };
  const s = await generateSuggestions(conversationId);
  assert.ok(s.options.every((o) => !o.booking));
});

test("แท็กลับไม่อยู่ในรายการให้ AI เลือก", async () => {
  const { conversationId } = await incoming("เปิดกี่โมงคะ");
  await generateSuggestions(conversationId);
  assert.doesNotMatch(calls.lastPrompt.split("## รายการแท็กที่เลือกได้")[1].split("##")[0], /STD/);
});

// ---- push ----
const subs = () => { state.tables.push_subscriptions = ["admin", "allowed", "denied"].map((id) => ({ endpoint: `https://p/${id}`, staff_id: id, p256dh: "p", auth: "a" })); };

test("push: เฉพาะคนมีสิทธิ์ ข้อความตายตัว ไม่มีเนื้อหา", async () => {
  subs();
  const sent = [];
  await notifySensitiveChat(async (sub, payload) => { sent.push([sub.endpoint, payload]); });
  assert.deepEqual(sent.map(([e]) => e).sort(), ["https://p/admin", "https://p/allowed"]);
  const payload = JSON.parse(sent[0][1]);
  assert.deepEqual(payload, { title: "DocDesk", body: "มีแชทลับใหม่", url: "/inbox" });
});

test("push คนที่ถูกปิดบัญชีไม่ได้รับ", async () => {
  subs();
  state.tables.staff.find((s) => s.id === "allowed").active = false;
  const sent = [];
  await notifySensitiveChat(async (sub) => { sent.push(sub.endpoint); });
  assert.deepEqual(sent, ["https://p/admin"]);
});

test("push นัดเดิมยังส่งทุกเครื่อง", async () => {
  subs();
  state.tables.bookings = [{ id: "b", status: "ai_confirmed", last_push_at: null }];
  assert.equal(await pushPendingBookings(Date.parse("2030-01-02T03:00:00Z"), async () => {}), 3);
});

// ---- เรียนรู้ ----
test("ตอบสดในแชทลับ: ไม่สร้าง reply_examples", async () => {
  const { conversationId } = await secretChat();
  await sendReply({ conversationId, textTh: "ตอบจำลองยาวพอค่ะ", senderType: "staff", senderId: "allowed" });
  assert.equal(state.tables.reply_examples.length, 0);
});

test("กดดาวในแชทลับ: ไม่สร้าง reply_examples", async () => {
  const { conversationId } = await secretChat();
  const { messageId } = await sendReply({ conversationId, textTh: "ตอบจำลองยาวพอค่ะ", senderType: "staff", senderId: "allowed" });
  await starMessage(messageId, "admin");
  assert.equal(state.tables.reply_examples.length, 0);
  assert.equal(state.tables.messages.find((m) => m.id === messageId).starred, true);
});

test("แชทกลายเป็นลับภายหลัง: ลบตัวอย่างเดิมของแชทนั้น", async () => {
  const { conversationId } = await incoming("เปิดกี่โมงคะ");
  await sendReply({ conversationId, textTh: "เปิดแปดโมงจำลองค่ะ", senderType: "staff", senderId: "allowed" });
  assert.equal(state.tables.reply_examples.length, 1);
  await incoming("ขอตรวจ HIV");
  assert.equal(conv().sensitive, true);
  assert.equal(state.tables.reply_examples.length, 0);
});

test("ส่งออกเทรน: ตัดคู่ที่มีคำสำคัญ", async () => {
  state.tables.reply_examples.push(
    { id: "e1", question: "ตรวจ HIV ได้ไหม", answer: "ได้ค่ะจำลอง", starred: true, use_count: 3, active: true },
    { id: "e2", question: "เปิดกี่โมง", answer: "แปดโมงจำลองค่ะ", starred: true, use_count: 3, active: true },
  );
  const body = await (await exportRoute.GET(new Request("https://a.test/x?all=1"))).text();
  assert.doesNotMatch(body, /HIV/);
  assert.match(body, /แปดโมงจำลอง/);
});

// ---- นำเข้า ----
test("นำเข้าห้องที่มีคำสำคัญ: ติดก่อนบันทึก ไม่สร้างตัวอย่าง", async () => {
  state.tables.contacts.push({ id: "cx", channel_id: "line", external_id: "U", display_name: "ลูกค้าจำลอง" });
  state.tables.channels.push({ id: "line", type: "line", enabled: true, created_at: nextTime() });
  state.tables.conversations.push({ id: "cv", contact_id: "cx", channel_id: "line", status: "open", tags: [] });
  state.tables.import_batches = [{ id: "b1", rooms: 0, messages_imported: 0, examples_imported: 0 }];
  const room = { key: "r", room: "ลูกค้าจำลอง", messages: [
    { room: "ลูกค้าจำลอง", sender: "customer", sent_at: "2026-05-01T03:00:00Z", text: "ถามเรื่องซิฟิลิสค่ะ" },
    { room: "ลูกค้าจำลอง", sender: "official", sent_at: "2026-05-01T03:01:00Z", text: "ตอบจำลองยาวพอค่ะ" },
  ] };
  const r = await importRoom("b1", room, new Set(), true);
  assert.equal(state.tables.conversations[0].sensitive, true);
  assert.equal(state.tables.conversations[0].sensitive_reason, "นำเข้า");
  assert.equal(r.messages, 2);
  assert.equal(r.examples, 0);
  assert.equal(state.tables.reply_examples.length, 0);
});

// ---- รูป ----
test("รูปในแชทลับลบเร็วกว่าแชทปกติ", async () => {
  state.tables.settings.push({ key: "media_retention_days", value: 90 }, { key: "sensitive_media_retention_days", value: 30 });
  const { conversationId } = await secretChat();
  const now = Date.parse("2026-11-01T00:00:00Z");
  const old = new Date(now - 40 * 86_400_000).toISOString();
  state.tables.messages.push(
    { id: "s1", conversation_id: conversationId, media_path: "a", media_preview_path: "b", created_at: old },
    { id: "n1", conversation_id: "ปกติ", media_path: "c", media_preview_path: "d", created_at: old },
  );
  assert.equal(await purgeExpiredMedia(now), 1);
  assert.equal(state.tables.messages.find((m) => m.id === "s1").media_path, null);
  assert.equal(state.tables.messages.find((m) => m.id === "n1").media_path, "c");
});

test("migration: นโยบาย RLS ครบทุกตาราง และ CSV ซ่อนชื่อ", () => {
  const sql = readFileSync("supabase/migrations/025_sensitive_chats.sql", "utf8");
  assert.match(sql, /array\['messages', 'suggestions', 'bookings', 'assignment_log'\]/);
  assert.match(sql, /create policy staff_read on contacts/);
  assert.match(sql, /media_is_sensitive\(name\)/);
  assert.match(sql, /'🔒 แชทลับ'/);
  assert.match(sql, /not c\.sensitive or e\.tag = 'STD'/);
  // รายการที่คนไม่มีสิทธิ์เห็น มีแค่รหัสแฮชกับเวลารอ
  assert.match(sql, /returns table \(key text, waiting_since timestamptz\)/);
});
