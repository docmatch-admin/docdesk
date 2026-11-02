// ทดสอบแชทเก่าจาก LINE OA ใช้ข้อมูลจำลองทั้งหมด: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { sendReply, storeIncoming } = await import("../src/lib/pipeline.ts");
const { generateSuggestions } = await import("../src/lib/suggest.ts");
const { groupRooms } = await import("../src/lib/line-import.ts");
const { importRoom } = await import("../src/lib/line-import-store.ts");
const { findArchiveCandidates } = await import("../src/lib/archive-store.ts");
const archiveRoute = await import("../src/app/api/conversations/[id]/archive/route.ts");
const sendRoute = await import("../src/app/api/conversations/[id]/send/route.ts");
const sendMediaRoute = await import("../src/app/api/conversations/[id]/send-media/route.ts");

const ADMIN = { id: "admin", email: "a@test" };
const DENIED = { id: "denied", email: "c@test" };
const CHAT_ID = `U${"c".repeat(32)}`;
const at = (m) => new Date(Date.parse("2026-06-01T03:00:00Z") + m * 60_000).toISOString();
const rec = (sender, m, text, extra = {}) => ({ room: "ลูกค้าเก่าจำลอง", room_id: CHAT_ID, sender, sent_at: at(m), text, ...extra });
const room = (...records) => groupRooms(records)[0];
const SAMPLE = room(rec("customer", 0, "ถามจำลองหน่อยค่ะ"), rec("official", 1, "ตอบจำลองค่ะนะ"), rec("customer", 2, "", { type: "sticker" }));

beforeEach(() => {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }],
    channels: [{ id: "line", type: "line", ai_mode: null, enabled: true, created_at: nextTime() }, { id: "web", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [], conversations: [], reply_examples: [], import_batches: [{ id: "b1", rooms: 0, messages_imported: 0, examples_imported: 0 }],
    tags: [{ id: "t", name: "STD", active: true }], tag_rules: [], tag_events: [], bookings: [], knowledge_items: [], lab_items: [], lab_packages: [],
    archive_merge_log: [], archive_merge_dismissed: [],
    staff: [{ id: "admin", role: "admin", active: true, display_name: "A" }, { id: "denied", role: "agent", active: true, display_name: "C" }],
  });
  state.currentUser = ADMIN;
});

const post = (body) => new Request("https://a.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const archived = () => state.tables.conversations.find((c) => c.archived);
const inChat = (id) => state.tables.messages.filter((m) => m.conversation_id === id);
const act = (id, body) => archiveRoute.POST(post(body), ctx(id));
/** ลูกค้าจริงทักมาทาง LINE ชื่อเดียวกัน ใช้ด้วยตนเองเพราะฝั่ง webhook เรียก LINE จริง */
function liveChat(name = "ลูกค้าเก่าจำลอง", id = "live") {
  state.tables.contacts.push({ id: `contact-${id}`, channel_id: "line", external_id: `U-${id}`, display_name: name, language: "th" });
  state.tables.conversations.push({ id, contact_id: `contact-${id}`, channel_id: "line", status: "open", tags: [], needs_human: false, last_direction: "in", waiting_since: at(1000) });
  state.tables.messages.push({ id: `real-${id}`, conversation_id: id, direction: "in", sender_type: "customer", body: "ทักใหม่จำลอง", created_at: "2026-10-30T03:00:00.000Z" });
  return id;
}

test("ห้องจับคู่ไม่ได้: สร้างแชทเก่า เก็บ chat id แยก และ external_id เดาไม่ได้", async () => {
  const r = await importRoom("b1", SAMPLE, new Set(), false, true);
  assert.deepEqual([r.messages, r.examples, r.archived], [3, 1, true]);
  const c = state.tables.contacts.find((x) => x.line_oa_chat_id === CHAT_ID);
  assert.equal(c.display_name, "ลูกค้าเก่าจำลอง");
  assert.match(c.external_id, /^archived:/);
  assert.notEqual(c.external_id, CHAT_ID);
  assert.deepEqual([archived().archived, archived().status], [true, "closed"]);
  assert.ok(inChat(archived().id).every((m) => m.imported && m.line_oa_chat_id === CHAT_ID));
});

test("แชทเก่าอยู่ในเสร็จแล้ว ใช้เวลาข้อความล่าสุดจริง ไม่ใช่เวลานำเข้า", async () => {
  const backward = room(rec("customer", 10, "ข้อความเวลาหลัง"), rec("official", 5, "ข้อความเวลาก่อนแต่อยู่ท้ายไฟล์", { seq: 1 }));
  backward.messages.forEach((m, i) => { m.seq = i; });
  await importRoom("b1", backward, new Set(), false, true);
  assert.equal(archived().status, "closed");
  assert.equal(archived().closed_at, at(10));
  assert.equal(archived().last_message_at, at(10));
});

test("แยกประวัติกลับเป็นแชทเก่า: closed_at เป็นเวลาข้อความ", async () => {
  const id = liveChat();
  await importRoom("b1", room(rec("customer", 0, "ถามจำลองหน่อยค่ะ"), rec("official", 1, "ตอบจำลองค่ะนะ")), new Set(), true, true);
  await act(id, { action: "split" });
  assert.equal(new Date(archived().closed_at).toISOString(), at(1));
});

test("แชทเก่าไม่เข้ารอตอบ", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  assert.equal(archived().waiting_since, undefined);
  assert.equal(archived().needs_human, false);
  assert.equal(archived().unread_count, undefined);
});

test("ปิดตัวเลือกสร้างแชทเก่า: เก็บแค่คู่คำตอบเหมือนเดิม", async () => {
  const r = await importRoom("b1", SAMPLE, new Set(), false, false);
  assert.deepEqual([r.messages, r.examples, r.archived], [0, 1, false]);
  assert.equal(state.tables.conversations.length, 0);
});

test("ไฟล์รูปแบบเก่าไม่มี chat id: ไม่สร้างแชทเก่า", async () => {
  const r = await importRoom("b1", room({ room: "ก", sender: "customer", sent_at: at(0), text: "ถามหน่อย" }), new Set(), false, true);
  assert.equal(r.archived, false);
});

test("นำเข้าซ้ำ: ไม่สร้างแชทหรือข้อความเพิ่ม", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  const r = await importRoom("b1", SAMPLE, new Set(), false, true);
  assert.equal(r.messages, 0);
  assert.equal(state.tables.conversations.length, 1);
});

test("รวมไปแล้วนำเข้าไฟล์เดิมซ้ำ: ไม่สร้างแชทเก่าว่างเปล่า", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  liveChat();
  await act("live", { action: "merge", archivedId: archived().id });
  const r = await importRoom("b1", SAMPLE, new Set(), false, true);
  assert.deepEqual([r.messages, r.archived], [0, false]);
  assert.equal(state.tables.conversations.filter((c) => c.archived).length, 0);
});

test("ห้องมีคำสำคัญ: แชทเก่าติดลับก่อนบันทึก ไม่สร้างคู่คำตอบ", async () => {
  const r = await importRoom("b1", room(rec("customer", 0, "ถาม HIV จำลอง"), rec("official", 1, "ตอบจำลองค่ะนะ")), new Set(), false, true);
  assert.equal(archived().sensitive, true);
  assert.ok(archived().tags.includes("STD"));
  assert.equal(archived().needs_human, false);
  assert.deepEqual([r.messages, r.examples], [2, 0]);
});

test("แชทเก่า: ส่งข้อความและรูปไม่ได้", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  const id = archived().id;
  const send = await sendRoute.POST(post({ text: "ตอบ" }), ctx(id));
  assert.equal(send.status, 409);
  assert.match((await send.json()).error, /ส่งข้อความไม่ได้/);
  assert.equal((await sendMediaRoute.POST(post({ quickMediaId: "x" }), ctx(id))).status, 409);
});

test("แชทเก่า: AI ไม่ร่างและไม่เรียก LLM", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  const s = await generateSuggestions(archived().id);
  assert.equal(s.skipped, "no_reply_needed");
  assert.equal(calls.chat, 0);
});

test("ไม่รวมเอง: ลูกค้าทักมาชื่อเดียวกัน แค่ถาม", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  const id = liveChat();
  const { candidates } = await (await archiveRoute.GET(post(), ctx(id))).json();
  assert.equal(candidates.length, 1);
  assert.deepEqual([candidates[0].messages, candidates[0].from], [3, at(0)]);
  assert.equal(inChat(id).length, 1);
  assert.ok(archived());
});

test("คำแนะนำไม่มีเนื้อหาข้อความ", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  const body = JSON.stringify(await (await archiveRoute.GET(post(), ctx(liveChat()))).json());
  assert.doesNotMatch(body, /ถามจำลอง|ตอบจำลอง/);
});

test("รวม: ย้ายข้อความ ลบแชทเก่าและรายชื่อ ยกแท็กมา บันทึก log", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  const old = archived();
  old.tags = ["ลูกค้าประจำ"];
  const contactId = old.contact_id;
  const id = liveChat();
  const before = JSON.stringify({ w: state.tables.conversations.find((c) => c.id === id).waiting_since });
  const res = await act(id, { action: "merge", archivedId: old.id });
  assert.deepEqual(await res.json(), { moved: 3 });
  assert.equal(inChat(id).length, 4);
  assert.equal(state.tables.conversations.find((c) => c.archived), undefined);
  assert.equal(state.tables.contacts.find((c) => c.id === contactId), undefined);
  const live = state.tables.conversations.find((c) => c.id === id);
  assert.ok(live.tags.includes("ลูกค้าประจำ"));
  assert.ok(live.archive_merged_at);
  assert.equal(JSON.stringify({ w: live.waiting_since }), before, "คิวไม่เปลี่ยน");
  assert.deepEqual(state.tables.archive_merge_log.map((l) => [l.action, l.conversation_id, l.line_oa_chat_id, l.messages, l.staff_id]), [["merge", id, CHAT_ID, 3, "admin"]]);
});

test("รวมแชทลับ: ยกสถานะลับมา", async () => {
  await importRoom("b1", room(rec("customer", 0, "ถาม HIV จำลอง")), new Set(), false, true);
  const id = liveChat();
  await act(id, { action: "merge", archivedId: archived().id });
  const live = state.tables.conversations.find((c) => c.id === id);
  assert.equal(live.sensitive, true);
  assert.equal(live.sensitive_reason, "รวมประวัติ");
  assert.ok(live.tags.includes("STD"));
});

test("แชทลับ: คนไม่มีสิทธิ์ไม่เห็นตัวเลือกและรวมไม่ได้", async () => {
  await importRoom("b1", room(rec("customer", 0, "ถาม HIV จำลอง")), new Set(), false, true);
  const id = liveChat();
  const oldId = archived().id;
  state.currentUser = DENIED;
  assert.deepEqual((await (await archiveRoute.GET(post(), ctx(id))).json()).candidates, []);
  assert.equal((await act(id, { action: "merge", archivedId: oldId })).status, 404);
  assert.equal(inChat(oldId).length, 1);
});

test("ไม่ใช่คนเดียวกัน: ไม่ถามอีก บันทึก log แชทเก่ายังอยู่", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  const id = liveChat();
  const oldId = archived().id;
  assert.equal((await act(id, { action: "dismiss", archivedId: oldId })).status, 200);
  assert.deepEqual(await findArchiveCandidates(id, true), []);
  assert.ok(archived());
  assert.equal(state.tables.archive_merge_log.at(-1).action, "dismiss");
  assert.equal((await act(id, { action: "merge", archivedId: oldId })).status, 404, "ปฏิเสธแล้วรวมไม่ได้");
});

test("ชื่อไม่ตรง: รวมด้วย id ตรงๆ ไม่ได้", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  const id = liveChat("ชื่ออื่นจำลอง");
  assert.equal((await act(id, { action: "merge", archivedId: archived().id })).status, 404);
});

test("ชื่อตรงหลายแชท: แสดงทั้งหมดให้เลือก", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  const other = `U${"d".repeat(32)}`;
  await importRoom("b1", room(rec("customer", 5, "อีกห้องจำลอง", { room_id: other })), new Set(), false, true);
  const list = await findArchiveCandidates(liveChat(), true);
  assert.equal(list.length, 2);
});

test("รวมแล้วไม่ถามอีก", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  const other = `U${"d".repeat(32)}`;
  await importRoom("b1", room(rec("customer", 5, "อีกห้องจำลอง", { room_id: other })), new Set(), false, true);
  const id = liveChat();
  const [first] = await findArchiveCandidates(id, true);
  await act(id, { action: "merge", archivedId: first.id });
  assert.deepEqual(await findArchiveCandidates(id, true), []);
});

test("ช่องทางอื่นไม่ถาม แชทเก่าไม่ถาม", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  assert.deepEqual(await findArchiveCandidates(archived().id, true), []);
  state.tables.contacts.push({ id: "w", channel_id: "web", external_id: "w", display_name: "ลูกค้าเก่าจำลอง" });
  state.tables.conversations.push({ id: "webchat", contact_id: "w", channel_id: "web", tags: [] });
  assert.deepEqual(await findArchiveCandidates("webchat", true), []);
});

test("แยกประวัติ: ย้ายเฉพาะข้อความนำเข้ากลับเป็นแชทเก่า ไม่ถามรวมอีก", async () => {
  const id = liveChat();
  const matched = room(rec("customer", 0, "ถามจำลองหน่อยค่ะ"), rec("official", 1, "ตอบจำลองค่ะนะ"));
  assert.equal((await importRoom("b1", matched, new Set(), true, true)).matched, true);
  assert.equal(inChat(id).length, 3);
  const res = await act(id, { action: "split" });
  assert.deepEqual(await res.json(), { moved: 2, chats: 1 });
  assert.deepEqual(inChat(id).map((m) => m.id), [`real-${id}`], "ข้อความจริงอยู่ที่เดิม");
  const back = archived();
  assert.equal(inChat(back.id).length, 2);
  assert.equal(state.tables.contacts.find((c) => c.id === back.contact_id).line_oa_chat_id, CHAT_ID);
  assert.deepEqual(await findArchiveCandidates(id, true), []);
  assert.equal(state.tables.archive_merge_log.at(-1).action, "split");
});

test("แยกประวัติที่มีคำสำคัญ: แชทเก่าที่สร้างใหม่ติดลับ", async () => {
  const id = liveChat();
  await importRoom("b1", room(rec("customer", 0, "ถาม HIV จำลอง")), new Set(), true, true);
  await act(id, { action: "split" });
  assert.equal(archived().sensitive, true);
});

test("เจ้าหน้าที่ตอบแล้ว: แยกประวัติไม่ได้ ข้อความ AI ไม่นับ", async () => {
  const id = liveChat();
  await importRoom("b1", room(rec("customer", 0, "ถามจำลองหน่อยค่ะ"), rec("official", 1, "ตอบจำลองค่ะนะ")), new Set(), true, true);
  state.tables.messages.push({ id: "ai-reply", conversation_id: id, direction: "out", sender_type: "ai", body: "AI ตอบจำลอง", imported: false, created_at: "2026-10-30T03:01:00.000Z" });
  state.tables.messages.push({ id: "staff-reply", conversation_id: id, direction: "out", sender_type: "staff", body: "เจ้าหน้าที่ตอบจำลอง", imported: false, created_at: "2026-10-30T03:02:00.000Z" });
  const res = await act(id, { action: "split" });
  assert.equal(res.status, 409);
  assert.equal(inChat(id).filter((m) => m.imported).length, 2, "ประวัตินำเข้ายังอยู่ที่เดิม");
});

test("แยกซ้ำหรือไม่มีประวัตินำเข้า: 404", async () => {
  assert.equal((await act(liveChat(), { action: "split" })).status, 404);
});

test("คะแนนและรอตอบไม่นับข้อความนำเข้าหลังรวม", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  const id = liveChat();
  await act(id, { action: "merge", archivedId: archived().id });
  state.tables.conversations.find((c) => c.id === id).channel_id = "web";
  state.tables.contacts.find((c) => c.id === `contact-${id}`).external_id = "11111111-1111-4111-8111-111111111111";
  state.tables.messages.find((m) => m.id === `real-${id}`).created_at = new Date(Date.now() - 60_000).toISOString();
  await sendReply({ conversationId: id, textTh: "ตอบข้อความจริงยาวพอให้คิดคะแนนค่ะ", senderType: "staff", senderId: "admin" });
  assert.equal(state.tables.response_events[0].inbound_message_id, `real-${id}`);
});

test("webhook ยังสร้างรายชื่อใหม่ ไม่ไปรวมกับแชทเก่าเอง", async () => {
  await importRoom("b1", SAMPLE, new Set(), false, true);
  state.tables.channels.find((c) => c.id === "web").type = "web";
  const before = state.tables.conversations.length;
  await storeIncoming({ channelType: "web", externalId: "22222222-2222-4222-8222-222222222222", text: "สวัสดีค่ะ", displayName: "ลูกค้าเก่าจำลอง" });
  assert.equal(state.tables.conversations.length, before + 1);
  assert.ok(archived());
});

test("migration: กันการเปิดแชทเก่า และคอลัมน์แยก", () => {
  const sql = readFileSync("supabase/migrations/026_archived_chats.sql", "utf8");
  assert.match(sql, /line_oa_chat_id text unique/);
  assert.match(sql, /แชทเก่าเปิดใหม่ไม่ได้/);
  assert.match(sql, /not c\.archived/);
});
