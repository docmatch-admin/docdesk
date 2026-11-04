// ทดสอบการลดการเรียก LLM ด้วยโค้ดจริงของ pipeline และ suggest แทนเฉพาะ OpenAI กับฐานข้อมูล: npm test
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { aiTiming, processIncoming, runFallback, storeIncoming } = await import("../src/lib/pipeline.ts");
const { ensureSuggestions, generateSuggestions } = await import("../src/lib/suggest.ts");
const { classifyAck, hasSensitiveSignal, hasUrgentSignal, shouldSkipSuggestion } = await import("../src/lib/suggest-rules.ts");
const { estimateCostThb, recordLlmUsage, summarizeUsage } = await import("../src/lib/llm-usage.ts");

const STARRED = {
  id: "ex1", question: "คลินิกเปิดกี่โมง", answer: "คลินิกเปิด 08.00 น. ค่ะ", starred: true,
  use_count: 0, created_at: "2026-01-01T00:00:00Z", similarity: 0.95,
};
const HOURS = { id: "k1", category: "ข้อมูลคลินิก", title: "เวลาทำการ", content: "เปิด 08.00–18.00 น.", updated_at: "2026-01-01T00:00:00Z", active: true };

function setup(mode) {
  resetDb({
    settings: [{ key: "ai_mode", value: mode }],
    channels: [{ id: "ch", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [],
    conversations: [],
    knowledge_items: [HOURS],
  });
}
const incoming = (text, id) => storeIncoming({ channelType: "web", externalId: "11111111-1111-4111-8111-111111111111", text, externalMessageId: id });
const conv = () => state.tables.conversations[0];
const out = () => state.tables.messages.filter((m) => m.direction === "out");
const addOutbound = (body) => state.tables.messages.push({
  id: `out-${state.tables.messages.length}`, conversation_id: conv().id, direction: "out", sender_type: "staff", body, body_th: null, created_at: nextTime(),
});

beforeEach(() => {
  reset();
  aiTiming.debounceMs = 30;
  replies.next = { needs_human: false, options: [{ text: "ร่างจาก LLM", source: "knowledge", ref_ids: [], confidence: 0.8 }] };
});

// ---- ข้อกำหนดที่สั่งทดสอบ ----
test("ส่ง 5 ข้อความติดกันในโหมด auto: เรียก LLM ครั้งเดียว และตอบครั้งเดียว", async () => {
  setup("auto");
  const jobs = [];
  for (const text of ["สวัสดีค่ะ", "สอบถามหน่อยค่ะ", "วัคซีนมีแบบไหนบ้าง", "ลูกอายุ 9 ปี", "ฉีดได้เลยไหมคะ"]) {
    const s = await incoming(text);
    jobs.push(processIncoming(s.conversationId, s.messageId));
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(calls.chat, 0, "ยังอยู่ในช่วงรอ ห้ามเรียก LLM");
  await Promise.all(jobs);
  assert.equal(calls.chat, 1);
  assert.equal(state.tables.suggestions.length, 1);
  assert.equal(out().length, 1);
});

test("ข้อความใหม่เข้าหลังเริ่มรอ ต่อเวลารอออกไป", async () => {
  setup("auto");
  aiTiming.debounceMs = 60;
  const a = await incoming("ถามเรื่องวัคซีนค่ะ");
  const first = processIncoming(a.conversationId, a.messageId);
  await new Promise((r) => setTimeout(r, 40));
  const b = await incoming("ราคาเท่าไหร่คะ");
  const second = processIncoming(b.conversationId, b.messageId);
  await first;
  assert.equal(calls.chat, 0, "รอบแรกหมดเวลาแล้วแต่มีข้อความใหม่ ต้องยังไม่เรียก");
  await second;
  assert.equal(calls.chat, 1);
});

test("ค่ารอจริงคือ 8 วินาที", async () => {
  const source = (await import("node:fs")).readFileSync("src/lib/pipeline.ts", "utf8");
  assert.match(source, /debounceMs: 8_000/);
});

for (const mode of ["auto", "fallback"]) {
  test(`"ขอบคุณค่ะ" โหมด ${mode}: ไม่เรียก AI ไม่ติด needs_human ไม่ตั้งเวลา`, async () => {
    setup(mode);
    const s = await incoming("ขอบคุณค่ะ");
    await processIncoming(s.conversationId, s.messageId);
    assert.deepEqual(calls, { chat: 0, embed: 0 });
    assert.equal(conv().needs_human ?? false, false);
    assert.equal(conv().ai_due_at ?? null, null);
    assert.equal(out().length, 0);
  });
}

test("คำถามซ้ำคำตอบดาว: ไม่เรียก LLM ใช้คำตอบดาวเป็นตัวเลือกแรก", async () => {
  setup("assist");
  const s = await incoming("คลินิกเปิดกี่โมงคะ");
  state.matchExamples = [STARRED];
  const r = await generateSuggestions(s.conversationId);
  assert.equal(calls.chat, 0);
  assert.equal(calls.embed, 1);
  assert.deepEqual(r.options, [{ text: STARRED.answer, source: "example", ref_ids: ["ex1"], confidence: 0.9 }]);
  assert.equal(state.tables.suggestions.length, 1);
});

// ---- ข้อ 1: off / assist ----
// ร่างล่วงหน้าเพื่อติดแท็ก แต่ไม่ส่งถึงลูกค้า
for (const mode of ["off", "assist"]) {
  test(`โหมด ${mode}: ข้อความเข้าร่างล่วงหน้า 1 ครั้ง แต่ไม่ส่ง`, async () => {
    setup(mode);
    const s = await incoming("วัคซีนราคาเท่าไหร่");
    await processIncoming(s.conversationId, s.messageId);
    assert.equal(calls.chat, 1);
    assert.equal(state.tables.suggestions.length, 1);
    assert.equal(out().length, 0);
    assert.equal(conv().ai_due_at ?? null, null);
  });
}

test("assist: เรื่องด่วนยังขึ้นป้ายต้องให้คนตอบ และไม่ส่ง", async () => {
  setup("assist");
  const s = await incoming("ปวดหัวมาก กินยาอะไรดี");
  await processIncoming(s.conversationId, s.messageId);
  assert.equal(conv().needs_human, true);
  assert.equal(out().length, 0);
});

test("เปิดแชทหลายครั้ง: สร้างครั้งเดียวต่อชุดข้อความ และสร้างใหม่เมื่อมีข้อความใหม่", async () => {
  setup("assist");
  const s = await incoming("วัคซีนราคาเท่าไหร่");
  const first = await ensureSuggestions(s.conversationId);
  const again = await ensureSuggestions(s.conversationId);
  assert.equal(calls.chat, 1);
  assert.equal(again.id, first.id);

  await incoming("แล้วเด็กฉีดได้ไหม");
  await ensureSuggestions(s.conversationId);
  assert.equal(calls.chat, 2);
});

test("เปิดแชทที่ตอบไปแล้ว: ไม่เรียก LLM", async () => {
  setup("assist");
  const s = await incoming("วัคซีนราคาเท่าไหร่");
  addOutbound("1,800 บาทค่ะ");
  const r = await ensureSuggestions(s.conversationId);
  assert.equal(r.skipped, "answered");
  assert.deepEqual(calls, { chat: 0, embed: 0 });
});

test("กดแนะนำใหม่: เรียก LLM เสมอ แม้มีคำแนะนำแล้วหรือตรงคำตอบดาว", async () => {
  setup("assist");
  const s = await incoming("คลินิกเปิดกี่โมงคะ");
  state.matchExamples = [STARRED];
  await generateSuggestions(s.conversationId);
  await generateSuggestions(s.conversationId, { force: true });
  assert.equal(calls.chat, 1);
});

test("เปิดแชทระหว่าง server กำลังร่าง (auto): ไม่เรียก LLM ซ้ำ", async () => {
  setup("auto");
  const s = await incoming("วัคซีนราคาเท่าไหร่");
  const at = Date.parse(state.tables.messages[0].created_at);
  assert.equal((await ensureSuggestions(s.conversationId, at + 5000)).skipped, "in_progress");
  assert.equal(calls.chat, 0);
  await ensureSuggestions(s.conversationId, at + 60_000);
  assert.equal(calls.chat, 1);
});

test("เว็บเกินเพดาน AI: เปิดแชทไม่สร้างคำแนะนำให้เอง", async () => {
  setup("assist");
  const s = await incoming("วัคซีนราคาเท่าไหร่");
  const now = Date.parse("2026-11-01T05:00:00Z");
  state.tables.ai_daily_usage.push({ channel: "web", day: "2026-11-01", count: 300 });
  assert.equal((await ensureSuggestions(s.conversationId, now)).skipped, "cap");
  assert.equal(calls.chat, 0);
});

// ---- ข้อ 2: fallback ไม่ร่างซ้ำตอน cron ----
test("fallback: ร่างตอนข้อความเข้าแล้ว cron ใช้ของเดิม รวมเรียก LLM ครั้งเดียว", async () => {
  setup("fallback");
  state.tables.settings.push({ key: "business_hours", value: { tz: "Asia/Bangkok", days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ["00:00", "23:59"]])) } });
  const s = await incoming("วัคซีนราคาเท่าไหร่");
  await processIncoming(s.conversationId, s.messageId);
  assert.equal(calls.chat, 1);
  assert.ok(conv().ai_due_at);

  conv().ai_due_at = new Date(Date.now() - 1000).toISOString();
  const r = await runFallback();
  assert.equal(calls.chat, 1);
  assert.equal(r.sent, 1);
});

test("auto: เรื่องที่ต้องให้คนดูแล ยังไม่ส่งเอง", async () => {
  setup("auto");
  replies.next = { needs_human: true, options: [{ text: "แนะนำให้มาพบแพทย์", source: "knowledge", ref_ids: [], confidence: 0.9 }] };
  const s = await incoming("ลูกมีผื่นขึ้นทั้งตัว");
  await processIncoming(s.conversationId, s.messageId);
  assert.equal(out().length, 0);
  assert.equal(conv().needs_human, true);
});

// ---- ข้อ 3: กฎคำขอบคุณ ----
for (const text of ["ขอบคุณค่ะ", "ขอบคุณมากๆ นะคะ", "ขอบคุณคะ", "thank you so much!", "Thanks", "โอเคค่ะ", "รับทราบครับ", "ok", "ค่ะ", "🙏", "👍👍", "[ลูกค้าส่ง sticker — เปิดดูใน LINE OA]", "[ลูกค้าส่งสติกเกอร์ — เปิดดูใน Meta Business Suite]", "ขอบคุณค่ะ\n🙏"]) {
  test(`ไม่ต้องร่าง: ${text}`, () => assert.equal(shouldSkipSuggestion(text, null), true));
}
for (const text of ["ขอบคุณค่ะ แล้วราคาเท่าไหร่", "โอเคค่ะ เปิดกี่โมง", "ราคาเท่าไหร่", "ได้ไหมคะ", "?", "คะ", "ok?", "ขอบคุณค่ะ\nแล้วเสาร์เปิดไหม", "1"]) {
  test(`ต้องร่าง: ${text}`, () => assert.equal(shouldSkipSuggestion(text, null), false));
}

test("ตอบรับหลังคลินิกถาม ต้องร่างต่อ แต่คำขอบคุณไม่ต้อง", () => {
  for (const q of ["สะดวกวันเสาร์ไหมคะ", "รับนัดเลยมั้ย", "สะดวกวันไหนคะ", "ยืนยันนะคะ?"]) {
    assert.equal(shouldSkipSuggestion("โอเคค่ะ", q), false, q);
    assert.equal(shouldSkipSuggestion("👍", q), false, q);
    assert.equal(shouldSkipSuggestion("ขอบคุณค่ะ", q), true, q);
  }
  assert.equal(shouldSkipSuggestion("โอเคค่ะ", "นัดวันเสาร์เรียบร้อยแล้วค่ะ"), true);
});

test("classifyAck แยกคำขอบคุณกับการตอบรับ", () => {
  assert.equal(classifyAck("ขอบคุณครับ"), "thanks");
  assert.equal(classifyAck("ครับ"), "affirm");
  assert.equal(classifyAck("สวัสดีครับ"), null);
});

// ---- ข้อ 4: คำตอบดาวต้องปลอดภัยเท่า LLM ----
async function starredCase(question, example = STARRED) {
  setup("auto");
  const s = await incoming(question);
  state.matchExamples = [example];
  const r = await generateSuggestions(s.conversationId);
  return { s, r };
}

test("คำตอบดาวตัวเลขเก่า ไม่ตรงฐานข้อมูล: เรียก LLM แทน", async () => {
  await starredCase("HPV ราคาเท่าไหร่", { ...STARRED, question: "HPV ราคาเท่าไหร่", answer: "HPV เข็มละ 1,500 บาทค่ะ" });
  assert.equal(calls.chat, 1);
});

test("คำตอบดาวตัวเลขไม่นับตัวเองเป็นแหล่งยืนยัน", async () => {
  state.matchKnowledge = [];
  await starredCase("เปิดกี่โมง", { ...STARRED, answer: "เปิด 07.15 น. ค่ะ" });
  assert.equal(calls.chat, 1);
});

test("similarity ต่ำกว่า 0.92 หรือไม่ติดดาว: เรียก LLM", async () => {
  await starredCase("คลินิกเปิดกี่โมงคะ", { ...STARRED, similarity: 0.919 });
  assert.equal(calls.chat, 1);
  reset();
  await starredCase("คลินิกเปิดกี่โมงคะ", { ...STARRED, starred: false });
  assert.equal(calls.chat, 1);
});

test("เรื่องอาการหรือยา: ไม่ใช้คำตอบดาว ต้องผ่าน LLM", async () => {
  await starredCase("ปวดหัวเปิดกี่โมงคะ");
  assert.equal(calls.chat, 1);
});

test("คุยต่อเนื่อง: คำถามอาจหมายถึงเรื่องก่อนหน้า ต้องผ่าน LLM", async () => {
  setup("auto");
  await incoming("สนใจวัคซีน HPV ค่ะ");
  addOutbound("มีค่ะ");
  const s = await incoming("เปิดกี่โมงคะ");
  state.matchExamples = [STARRED];
  await generateSuggestions(s.conversationId);
  assert.equal(calls.chat, 1);
});

test("คัดกรองคำไวต่อการแพทย์ ไม่สับสนกับคำทั่วไป", () => {
  assert.equal(hasSensitiveSignal("อยากทราบเวลาเปิดค่ะ"), false);
  assert.equal(hasSensitiveSignal("ขอไอดีไลน์หน่อย"), false);
  assert.equal(hasSensitiveSignal("กินยาแล้วไม่หาย"), true);
  assert.equal(hasUrgentSignal("อยากทราบเวลาเปิดค่ะ"), false);
  assert.equal(hasUrgentSignal("ขอคุยกับเจ้าหน้าที่"), true);
});

// ---- ข้อ 5: สถิติ ----
const row = (day, kind, model, calls_, input, output) => ({ day, kind, model, calls: calls_, input_tokens: input, output_tokens: output });

test("คำนวณค่าใช้จ่ายเป็นบาท", () => {
  // 1M input ($0.15) + 1M output ($0.60) + 1M embedding ($0.02) = $0.77 × 33
  const baht = estimateCostThb([
    row("2026-11-01", "chat", "gpt-4o-mini", 1, 1_000_000, 1_000_000),
    row("2026-11-01", "embedding", "text-embedding-3-small", 1, 1_000_000, 0),
  ]);
  assert.ok(Math.abs(baht - 25.41) < 1e-9, String(baht));
});

test("สรุปวันนี้/เดือนนี้ นับเฉพาะ chat เป็น LLM และแจ้งโมเดลที่ไม่รู้ราคา", () => {
  const s = summarizeUsage([
    row("2026-11-01", "chat", "gpt-4o-mini", 3, 0, 0),
    row("2026-11-01", "embedding", "text-embedding-3-small", 9, 0, 0),
    row("2026-11-02", "chat", "gpt-4o-mini", 4, 0, 0),
    row("2026-10-31", "chat", "gpt-4o-mini", 100, 0, 0),
    row("2026-11-02", "chat", "unknown-model", 1, 0, 0),
  ], "2026-11-02");
  assert.equal(s.todayCalls, 5);
  assert.equal(s.monthCalls, 8);
  assert.deepEqual(s.unpricedModels, ["unknown-model"]);
});

test("บันทึกการใช้งานล้มเหลวต้องไม่ทำให้งานหลักล้ม", async (t) => {
  t.mock.method(console, "error", () => {});
  await recordLlmUsage({ rpc: async () => { throw new Error("db down"); } }, "chat", "m", 1, 1);
  await recordLlmUsage({ rpc: async () => ({ error: new Error("rpc failed") }) }, "chat", "m", 1, 1);
});
