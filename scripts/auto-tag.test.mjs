// ติดแท็กอัตโนมัติจากข้อความลูกค้าทุกโหมด AI: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { aiTiming, processIncoming, setConversationTag, storeIncoming } = await import("../src/lib/pipeline.ts");
const { ensureSuggestions } = await import("../src/lib/suggest.ts");

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
const incoming = (text, extra = {}) => storeIncoming({ channelType: "web", externalId: SESSION, text, ...extra });
const conv = () => state.tables.conversations[0];
const out = () => state.tables.messages.filter((m) => m.direction === "out");
beforeEach(() => setup("assist"));

for (const mode of ["assist", "off"]) {
  test(`${mode}: ข้อความเข้าแล้วติดแท็ก topic เอง ไม่ส่งถึงลูกค้า และไม่ตั้งเวลาให้ AI ตอบ`, async () => {
    setup(mode);
    const s = await incoming("ฉีดวัคซีนไข้หวัดใหญ่ราคาเท่าไหร่");
    await processIncoming(s.conversationId, s.messageId);
    assert.deepEqual(conv().tags, ["วัคซีน"], "ติดเฉพาะกลุ่ม topic");
    assert.equal(calls.chat, 1);
    assert.equal(out().length, 0);
    assert.equal(conv().ai_due_at ?? null, null);
  });
}

test("แท็กที่เจ้าหน้าที่เอาออกเองไม่ถูกติดกลับ", async () => {
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  await processIncoming(s.conversationId, s.messageId);
  assert.deepEqual(conv().tags, ["วัคซีน"]);
  await setConversationTag(s.conversationId, "วัคซีน", "remove", "staff");
  const s2 = await incoming("แล้ววัคซีนตับอักเสบบีล่ะคะ");
  await processIncoming(s2.conversationId, s2.messageId);
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

test("แชทลับ: ไม่เรียก LLM ใน assist", async () => {
  const s = await incoming("สอบถามค่ะ");
  conv().sensitive = true;
  await processIncoming(s.conversationId, s.messageId);
  assert.equal(calls.chat, 0);
  assert.equal(state.tables.suggestions.length, 0);
});

for (const text of ["ขอบคุณค่ะ", "[ลูกค้าส่ง sticker — เปิดดูใน LINE OA]"]) {
  test(`คำขอบคุณ/สติกเกอร์ล้วน: ไม่เรียก LLM (${text.slice(0, 12)})`, async () => {
    const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
    state.tables.messages.push({ id: "o1", conversation_id: s.conversationId, direction: "out", sender_type: "staff", body: "เข็มละ 390 บาทค่ะ", created_at: nextTime() });
    const s2 = await incoming(text);
    await processIncoming(s2.conversationId, s2.messageId);
    assert.equal(calls.chat, 0);
  });
}

test("รูปอย่างเดียว: webhook ไม่เรียก processIncoming", () => {
  for (const f of ["src/app/api/webhooks/line/route.ts", "src/app/api/webhooks/meta/route.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /ingestInboundImage/);
    assert.match(src, /else if \([^)]*(isText|"text")[^)]*\)\s*\{\s*after\(\(\) => processIncoming/);
  }
});

test("แชทที่ยังปิดอยู่: ไม่เรียก LLM", async () => {
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  conv().status = "closed";
  await processIncoming(s.conversationId, s.messageId);
  assert.equal(calls.chat, 0);
});

test("ข้อความหลายชุด: ร่างครั้งเดียวจากข้อความล่าสุด", async () => {
  aiTiming.debounceMs = 40;
  const a = await incoming("สวัสดีค่ะ");
  const first = processIncoming(a.conversationId, a.messageId);
  const b = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  await Promise.all([first, processIncoming(b.conversationId, b.messageId)]);
  assert.equal(calls.chat, 1);
});

test("เจ้าหน้าที่เปิดแชทหลังร่างเสร็จ: ใช้คำแนะนำเดิม ไม่เรียก LLM ซ้ำ", async () => {
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  await processIncoming(s.conversationId, s.messageId);
  const r = await ensureSuggestions(s.conversationId, Date.now() + 60_000);
  assert.equal(calls.chat, 1);
  assert.equal(r.id, state.tables.suggestions[0].id);
  assert.equal(r.options[0].text, "เข็มละ 390 บาทค่ะ");
});

test("เจ้าหน้าที่เปิดแชทระหว่างระบบกำลังร่าง: รอผล ไม่เรียก LLM เอง", async () => {
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  const sentAt = Date.parse(state.tables.messages.at(-1).created_at);
  const r = await ensureSuggestions(s.conversationId, sentAt + 3_000);
  assert.equal(r.skipped, "in_progress");
  assert.equal(calls.chat, 0);
});

test("แชทลับใน assist: เปิดแชทแล้วร่างได้ทันที เพราะระบบไม่ได้ร่างไว้", async () => {
  const s = await incoming("สอบถามค่ะ");
  conv().sensitive = true;
  const r = await ensureSuggestions(s.conversationId, Date.parse(state.tables.messages.at(-1).created_at) + 3_000);
  assert.notEqual(r.skipped, "in_progress");
  assert.equal(calls.chat, 1);
});

test("เว็บ: เกินเพดาน AI รายวันไม่เรียก processIncoming", () => {
  const src = readFileSync("src/app/api/webchat/route.ts", "utf8");
  assert.match(src, /if \(admission\.ai_allowed\) \{\s*after\(\(\) => processIncoming/);
});

test("maxDuration พอสำหรับรอ 8 วินาทีและเรียก LLM 1 ครั้ง", () => {
  for (const f of ["src/app/api/webhooks/line/route.ts", "src/app/api/webhooks/meta/route.ts", "src/app/api/webchat/route.ts"]) {
    const m = readFileSync(f, "utf8").match(/export const maxDuration = (\d+)/);
    assert.ok(Number(m?.[1]) >= 30, f);
  }
});
