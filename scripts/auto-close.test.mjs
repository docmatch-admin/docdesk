// ทดสอบการปิดแชทเมื่อลูกค้าตอบรับหรือบอกลา และการจับชื่อลูกค้าจากแชท: npm test
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { replies, reset } = await import(fake("ai"));
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

// ---- จับชื่อลูกค้า ----
const llm = (customer_name) => ({ needs_human: false, suggested_tags: [], customer_name, options: [{ text: "สวัสดีค่ะ", source: "knowledge", ref_ids: [], confidence: 0.8 }] });
const contact = () => state.tables.contacts[0];

test("ลูกค้า Facebook บอกชื่อเอง: ตั้งชื่อให้ ไม่ล็อก", async () => {
  await storeIncoming({ channelType: "facebook", externalId: "PSID1", text: "สวัสดีค่ะ ชื่อมิ้นท์ค่ะ อยากนัดตรวจ", displayName: "ลูกค้า Facebook" });
  replies.next = llm("มิ้นท์");
  await generateSuggestions(conv().id, { force: true });
  assert.equal(contact().display_name, "มิ้นท์");
  assert.ok(!contact().name_locked);
});

test("ลูกค้าเว็บที่ไม่มีชื่อ: ตั้งชื่อให้", async () => {
  await say("ผมชื่อต้นครับ จะสอบถามราคาวัคซีน");
  replies.next = llm("ต้น");
  await generateSuggestions(conv().id, { force: true });
  assert.equal(contact().display_name, "ต้น");
});

test("ไม่ตั้งชื่อ: ชื่อไม่อยู่ในข้อความลูกค้า, มีชื่อจริงจาก LINE แล้ว, เจ้าหน้าที่ล็อกชื่อไว้, AI ส่งค่าแปลก", async () => {
  await storeIncoming({ channelType: "facebook", externalId: "PSID1", text: "อยากนัดตรวจค่ะ", displayName: "ลูกค้า Facebook" });
  replies.next = llm("สมหญิง");
  await generateSuggestions(conv().id, { force: true });
  assert.equal(contact().display_name, "ลูกค้า Facebook", "AI เดาชื่อที่ลูกค้าไม่ได้พิมพ์");

  for (const bad of ["", "0812345678", 42, "ก".repeat(41)]) {
    replies.next = llm(bad);
    await generateSuggestions(conv().id, { force: true });
    assert.equal(contact().display_name, "ลูกค้า Facebook", String(bad));
  }

  contact().name_locked = true;
  contact().display_name = "คุณมิ้นท์ (เจ้าหน้าที่ตั้ง)";
  await say("ชื่อมิ้นท์ค่ะ", "facebook", "PSID1");
  replies.next = llm("มิ้นท์");
  await generateSuggestions(conv().id, { force: true });
  assert.equal(contact().display_name, "คุณมิ้นท์ (เจ้าหน้าที่ตั้ง)");
});

test("ลูกค้า LINE มีชื่อบัญชีอยู่แล้ว: ไม่เขียนทับ", async () => {
  await storeIncoming({ channelType: "line", externalId: "U1", text: "ชื่อนกค่ะ", displayName: "Nok Line" });
  replies.next = llm("นก");
  await generateSuggestions(conv().id, { force: true });
  assert.equal(contact().display_name, "Nok Line");
});
