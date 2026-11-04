// ติดแท็กอัตโนมัติตอนร่างคำแนะนำ ไม่เรียก LLM เพิ่ม: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { aiTiming, processIncoming, setConversationTag, storeIncoming } = await import("../src/lib/pipeline.ts");
const { ensureSuggestions, generateSuggestions } = await import("../src/lib/suggest.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const TAGS = [
  { id: "t1", name: "วัคซีน", group: "topic", active: true, sort: 1 },
  { id: "t2", name: "รอนัด", group: "status", active: true, sort: 2 },
];

function setup(mode) {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: mode }],
    channels: [{ id: "ch", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [], conversations: [], tags: structuredClone(TAGS), tag_rules: [], tag_events: [], reply_examples: [], bookings: [],
    knowledge_items: [], lab_items: [], lab_packages: [],
  });
  aiTiming.debounceMs = 5;
  replies.next = { needs_human: false, suggested_tags: ["วัคซีน", "รอนัด"], options: [{ text: "เข็มละ 390 บาทค่ะ", source: "knowledge", ref_ids: [], confidence: 0.95 }] };
}
const incoming = (text) => storeIncoming({ channelType: "web", externalId: SESSION, text });
const conv = () => state.tables.conversations[0];
const out = () => state.tables.messages.filter((m) => m.direction === "out");
const openChat = (id) => ensureSuggestions(id, Date.now() + 60_000);
beforeEach(() => setup("assist"));

for (const mode of ["assist", "off"]) {
  test(`${mode}: ข้อความเข้าไม่เรียก LLM และไม่ส่งถึงลูกค้า`, async () => {
    setup(mode);
    const s = await incoming("ฉีดวัคซีนไข้หวัดใหญ่ราคาเท่าไหร่");
    await processIncoming(s.conversationId, s.messageId);
    assert.equal(calls.chat, 0);
    assert.equal(state.tables.suggestions.length, 0);
    assert.equal(out().length, 0);
    assert.equal(conv().ai_due_at ?? null, null);
  });

  test(`${mode}: เปิดแชทแล้วติดแท็ก topic จากการเรียก LLM ครั้งเดียวกับคำแนะนำ`, async () => {
    setup(mode);
    const s = await incoming("ฉีดวัคซีนไข้หวัดใหญ่ราคาเท่าไหร่");
    await processIncoming(s.conversationId, s.messageId);
    await openChat(s.conversationId);
    assert.equal(calls.chat, 1);
    assert.deepEqual(conv().tags, ["วัคซีน"], "ติดเฉพาะกลุ่ม topic");
    assert.equal(out().length, 0);
  });
}

test("เปิดแชทซ้ำ: ใช้คำแนะนำเดิม ไม่เรียก LLM และไม่ติดแท็กซ้ำ", async () => {
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  const first = await openChat(s.conversationId);
  const again = await openChat(s.conversationId);
  assert.equal(calls.chat, 1);
  assert.equal(again.id, first.id);
  assert.equal(state.tables.tag_events.length, 1);
});

test("แท็กที่เจ้าหน้าที่เอาออกเองไม่ถูกติดกลับ", async () => {
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  await openChat(s.conversationId);
  assert.deepEqual(conv().tags, ["วัคซีน"]);
  await setConversationTag(s.conversationId, "วัคซีน", "remove", "staff");
  await incoming("แล้ววัคซีนตับอักเสบบีล่ะคะ");
  await generateSuggestions(s.conversationId, { force: true });
  assert.equal(calls.chat, 2);
  assert.deepEqual(conv().tags, []);
});

test("เจ้าหน้าที่ติดกลับเองได้ แม้เคยเอาออก", async () => {
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  await setConversationTag(s.conversationId, "วัคซีน", "add", "staff");
  await setConversationTag(s.conversationId, "วัคซีน", "remove", "staff");
  await setConversationTag(s.conversationId, "วัคซีน", "add", "staff");
  assert.deepEqual(conv().tags, ["วัคซีน"]);
});

test("แชทลับ: ข้อความเข้าไม่เรียก LLM", async () => {
  const s = await incoming("สอบถามค่ะ");
  conv().sensitive = true;
  await processIncoming(s.conversationId, s.messageId);
  assert.equal(calls.chat, 0);
});

for (const text of ["ขอบคุณค่ะ", "[ลูกค้าส่ง sticker — เปิดดูใน LINE OA]"]) {
  test(`เปิดแชทที่มีแค่คำขอบคุณ/สติกเกอร์: ไม่เรียก LLM (${text.slice(0, 12)})`, async () => {
    const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
    state.tables.messages.push({ id: "o1", conversation_id: s.conversationId, direction: "out", sender_type: "staff", body: "เข็มละ 390 บาทค่ะ", created_at: nextTime() });
    await incoming(text);
    await openChat(s.conversationId);
    assert.equal(calls.chat, 0);
  });
}

test("auto: ติดแท็กตอนระบบร่างเองหลังข้อความเข้า", async () => {
  setup("auto");
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  await processIncoming(s.conversationId, s.messageId);
  assert.equal(calls.chat, 1);
  assert.deepEqual(conv().tags, ["วัคซีน"]);
});

test("ไม่มีเส้นทางเรียก LLM เพิ่มเพื่อติดแท็ก", () => {
  const src = readFileSync("src/lib/pipeline.ts", "utf8");
  assert.doesNotMatch(src, /autoApplyTopicTags/);
  assert.match(src, /if \(mode === "off" \|\| mode === "assist"\) \{[\s\S]{0,400}?return;\s*\}/);
});
