// ทดสอบการปิดแชทเมื่อลูกค้าตอบรับหรือบอกลา และการจับชื่อลูกค้าจากแชท: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { storeIncoming } = await import("../src/lib/pipeline.ts");
const { generateSuggestions } = await import("../src/lib/suggest.ts");
const { classifyClosingMessage, endsConversation } = await import("../src/lib/suggest-rules.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }],
    channels: [
      { id: "web", type: "web", name: "เว็บไซต์", ai_mode: null, enabled: true, created_at: nextTime() },
      { id: "fb", type: "facebook", name: "Facebook คลินิก", ai_mode: null, enabled: true, created_at: nextTime() },
      { id: "ln", type: "line", name: "LINE @clinic", ai_mode: null, enabled: true, created_at: nextTime() },
    ],
    contacts: [], conversations: [], tags: [], tag_rules: [], tag_events: [], reply_examples: [], bookings: [],
    knowledge_items: [], lab_items: [], lab_packages: [],
  });
});

const say = (text, channelType = "web", externalId = SESSION) => storeIncoming({ channelType, externalId, text });
const conv = () => state.tables.conversations[0];
const reply = (body) => state.tables.messages.push({
  id: `out-${state.tables.messages.length}`, conversation_id: conv().id, direction: "out", sender_type: "staff",
  body, body_th: body, imported: false, created_at: nextTime(),
});

// ---- กฎแยกประเภทข้อความ ----
test("แยกข้อความจบการคุย", () => {
  assert.equal(classifyClosingMessage("โอเคค่ะ"), "affirm");
  assert.equal(classifyClosingMessage("👍"), "affirm");
  assert.equal(classifyClosingMessage("[ลูกค้าส่ง sticker]"), "affirm");
  assert.equal(classifyClosingMessage("ขอบคุณมากค่ะ 🙏"), "thanks");
  assert.equal(classifyClosingMessage("ยังค่ะ เดียวขอปรึกษากับที่ทำงานเพิ่มเติมก่อน ขอบคุณค่ะ (ชอบ)"), "goodbye");
  assert.equal(classifyClosingMessage("ขอคิดดูก่อนนะคะ"), "goodbye");
  assert.equal(classifyClosingMessage("ไว้จะติดต่อมาใหม่ครับ"), "goodbye");
  assert.equal(classifyClosingMessage("เดี๋ยวขอถามแฟนก่อน"), "goodbye");
  assert.equal(classifyClosingMessage("ขอบคุณค่ะ\nแล้วเสาร์เปิดกี่โมงคะ"), null, "มีคำถามต่อ");
  assert.equal(classifyClosingMessage("เดี๋ยวขอปรึกษาก่อน แต่ราคาเท่าไหร่คะ"), null);
  assert.equal(classifyClosingMessage("ขอถามก่อนนะคะ"), null, "กำลังจะถาม ไม่ใช่บอกลา");
  assert.equal(classifyClosingMessage("ขอดูรูปก่อนได้ไหม"), null);
  assert.equal(classifyClosingMessage("ตรวจสุขภาพราคาเท่าไหร่"), null);
  assert.equal(classifyClosingMessage("", true), null, "รูปภาพ");
});

test("ปิดได้เมื่อเราตอบล่าสุด: โอเคหลังคำถามของเราไม่ปิด แต่บอกลาหรือขอบคุณปิด", () => {
  const out = (text) => ({ direction: "out", text });
  assert.equal(endsConversation("affirm", out("เปิด 8 โมงค่ะ")), true);
  assert.equal(endsConversation("affirm", out("สะดวกบ่ายสองไหมคะ")), false);
  assert.equal(endsConversation("affirm", out("ได้ผลเลือดแล้วจะรีบแจ้งนะคะ")), true, "นะคะ ไม่ใช่คำถาม");
  assert.equal(endsConversation("affirm", out("พรุ่งนี้ 10 โมงสะดวกคะ")), false);
  assert.equal(endsConversation("thanks", out("สะดวกบ่ายสองไหมคะ")), true);
  assert.equal(endsConversation("goodbye", out("สะดวกวันไหนคะ")), true);
  assert.equal(endsConversation("thanks", { direction: "in", text: "ราคาเท่าไหร่" }), false, "คำถามยังไม่ได้ตอบ");
  assert.equal(endsConversation("thanks", null), false);
  assert.equal(endsConversation(null, out("เปิด 8 โมงค่ะ")), false);
});

// ---- ปิดแชทจริง ----
test("ลูกค้าตอบ โอเค หลังเราตอบ: ย้ายไปเสร็จแล้วทันที", async () => {
  await say("เปิดกี่โมงคะ");
  reply("เปิด 08.00 น. ค่ะ");
  await say("โอเคค่ะ");
  assert.equal(conv().status, "closed");
  assert.equal(conv().needs_human, false);
});

test("ได้ค่ะ🙏 หลังเราบอกว่า จะรีบแจ้งนะคะ: ย้ายไปเสร็จแล้ว", async () => {
  await say("สวัสดีค่ะ");
  reply("ได้ผลเลือดแล้วจะรีบแจ้งนะคะ");
  await say("ได้ค่ะ🙏");
  assert.equal(conv().status, "closed");
});

test("สติกเกอร์หลังเราถาม สะดวกไหม: ยังเปิด เพราะเป็นคำตอบที่ต้องตอบต่อ", async () => {
  await say("อยากนัดตรวจค่ะ");
  reply("สะดวกพรุ่งนี้บ่ายสองไหมคะ");
  await say("[ลูกค้าส่ง sticker]");
  assert.equal(conv().status, "open");
});

test("บอกลาแบบประโยคหลังเราถาม: ปิด", async () => {
  await say("ตรวจสุขภาพราคาเท่าไหร่คะ");
  reply("ชุดเล็ก 990 บาทค่ะ สนใจนัดวันไหนดีคะ");
  await say("ยังค่ะ เดียวขอปรึกษากับที่ทำงานเพิ่มเติมก่อน ขอบคุณค่ะ (ชอบ)");
  assert.equal(conv().status, "closed");
});

test("ขอบคุณก่อนเราตอบ / มีคำถามต่อ: ไม่ปิด", async () => {
  await say("ราคาเท่าไหร่คะ");
  await say("ขอบคุณค่ะ");
  assert.equal(conv().status, "open", "คำถามยังไม่ได้ตอบ");
  reply("990 บาทค่ะ");
  await say("ขอบคุณค่ะ แล้วเสาร์เปิดไหมคะ");
  assert.equal(conv().status, "open");
});

test("ไม่ปิด: รอลงนัด, ต้องให้คนตอบ, แท็กตามต่อ/รอนัด", async () => {
  for (const patch of [{ booking_pending: true }, { needs_human: true }, { tags: ["ตามต่อ"] }, { tags: ["รอนัด"] }]) {
    reset();
    resetDb({ ...state.tables, channels: state.tables.channels, contacts: [], conversations: [], messages: [] });
    await say("เปิดกี่โมงคะ");
    reply("เปิด 08.00 น. ค่ะ");
    Object.assign(conv(), patch);
    await say("โอเคค่ะ");
    assert.equal(conv().status, "open", JSON.stringify(patch));
  }
});

test("แชทที่ปิดแล้ว: โอเคหลังคำตอบของเรายังปิดอยู่ คำถามใหม่เปิดกลับ", async () => {
  await say("เปิดกี่โมงคะ");
  reply("เปิด 08.00 น. ค่ะ");
  conv().status = "closed";
  await say("โอเคค่ะ");
  assert.equal(conv().status, "closed");
  await say("วันอาทิตย์เปิดไหมคะ");
  assert.equal(conv().status, "open");
});

// ---- AI ไม่ตั้งหรือแก้ชื่อลูกค้า ----
const llm = (extra = {}) => ({ needs_human: false, suggested_tags: [], options: [{ text: "สวัสดีค่ะ", source: "knowledge", ref_ids: [], confidence: 0.8 }], ...extra });
const contact = () => state.tables.contacts[0];

test("ลูกค้าบอกชื่อในแชท: AI ไม่เปลี่ยนชื่อ contact และ prompt ไม่ขอชื่อกลับมา", async () => {
  await storeIncoming({ channelType: "facebook", externalId: "PSID1", text: "สวัสดีค่ะ ชื่อมิ้นท์ค่ะ อยากนัดตรวจ", displayName: "ลูกค้า Facebook" });
  // แม้ LLM จะส่งชื่อกลับมา ระบบก็ไม่ใช้
  replies.next = llm({ customer_name: "มิ้นท์" });
  await generateSuggestions(conv().id, { force: true });
  assert.equal(contact().display_name, "ลูกค้า Facebook");
  assert.notEqual(contact().name_source, "ai");
  assert.doesNotMatch(calls.lastPrompt ?? "", /customer_name/);

  await say("ผมชื่อต้นครับ");
  replies.next = llm({ customer_name: "ต้น" });
  await generateSuggestions(conv().id, { force: true });
  assert.equal(state.tables.contacts.find((c) => c.external_id === SESSION)?.display_name ?? null, null);
});

test("ไม่มีโค้ดที่ให้ AI เขียนชื่อลูกค้า", () => {
  const src = readFileSync("src/lib/suggest.ts", "utf8");
  assert.doesNotMatch(src, /customer_name|saveDetectedName|pickDetectedName/);
  assert.doesNotMatch(src, /from\("contacts"\)\.update/);
});

test("ตอบรับแต่ยังมีงานค้าง: แชทยังเปิด แต่ไม่นับว่าลูกค้ารอคำตอบ (ไม่นับเวลา)", async () => {
  // ลากเสียงก็ยังเป็นคำตอบรับ
  for (const t of ["โอเคค่ะ ขอบคุณค่าา", "ขอบคุณค้าาา", "โอเคคค", "ครับบบ"]) assert.ok(classifyClosingMessage(t), t);
  for (const patch of [{ booking_pending: true }, { needs_human: true }, { tags: ["ตามต่อ"] }]) {
    reset();
    resetDb({ ...state.tables, channels: state.tables.channels, contacts: [], conversations: [], messages: [] });
    await say("เปิดกี่โมงคะ");
    reply("เปิด 08.00 น. ค่ะ");
    Object.assign(conv(), patch);
    await say("โอเคค่ะ ขอบคุณค่าา");
    assert.equal(conv().status, "open", JSON.stringify(patch));
    assert.equal(conv().last_direction, "out", JSON.stringify(patch));
    assert.equal(conv().waiting_since, null, JSON.stringify(patch));
  }
});

test("ข้อความจากระบบนัดนับเป็นคำตอบของเรา: ลูกค้าตอบ โอเค ขอบคุณ แล้วแชทปิด", async () => {
  reset();
  resetDb({ ...state.tables, channels: state.tables.channels, contacts: [], conversations: [], messages: [] });
  await say("ขอเลื่อนนัดค่ะ");
  state.tables.messages.push({ id: "sys-1", conversation_id: conv().id, direction: "out", sender_type: "system", imported_sender_name: "ระบบนัด",
    body: "รับเรื่องขอเลื่อนนัดแล้วค่ะ", body_th: null, imported: false, created_at: nextTime() });
  await say("โอเคค่ะ ขอบคุณค่ะ");
  assert.equal(conv().status, "closed");
  // ตอบกลับอัตโนมัติของเพจ (system อื่น) ยังไม่นับเป็นคำตอบ
  reset();
  resetDb({ ...state.tables, channels: state.tables.channels, contacts: [], conversations: [], messages: [] });
  await say("ขอเลื่อนนัดค่ะ");
  state.tables.messages.push({ id: "sys-2", conversation_id: conv().id, direction: "out", sender_type: "system", imported_sender_name: "ตอบกลับอัตโนมัติ",
    body: "ขอบคุณที่ติดต่อมา", body_th: null, imported: false, created_at: nextTime() });
  await say("ขอบคุณค่ะ");
  assert.equal(conv().status, "open");
});
