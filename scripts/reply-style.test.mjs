// ทดสอบความยาวและสำนวนคำตอบของ AI: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { aiTiming, processIncoming, storeIncoming } = await import("../src/lib/pipeline.ts");
const { AUTO_SEND_MIN_CONFIDENCE, generateSuggestions } = await import("../src/lib/suggest.ts");
const {
  applyClaimGuard, applyLengthGuard, applySameChannelGuard, LONG_ANSWER_MAX_CONFIDENCE, MAX_ANSWER_CHARS, pickStyleExamples, sortByStyle,
} = await import("../src/lib/suggest-rules.ts");
const { DEFAULT_CLINIC_PROFILE } = await import("../src/lib/mode.ts");
const { fromThai } = await import("../src/lib/translate.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const text = (n) => "ก".repeat(n);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

function setup(mode = "assist", extra = {}) {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: mode }],
    channels: [{ id: "ch", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [],
    conversations: [],
    tags: [],
    tag_rules: [],
    tag_events: [],
    reply_examples: [],
    ...extra,
  });
  aiTiming.debounceMs = 1;
}
beforeEach(() => setup());
const incoming = (body = "วัคซีนราคาเท่าไหร่") => storeIncoming({ channelType: "web", externalId: SESSION, text: body });
const llmReply = (options) => ({ needs_human: false, suggested_tags: [], options });
const opt = (body, confidence = 0.8, extra = {}) => ({ text: body, source: "knowledge", ref_ids: [], confidence, ...extra });

// ---- ตัวกันความยาว ----
test("ยาวไม่เกิน 200 ตัวอักษร: ไม่ลด", () => {
  const o = opt(text(MAX_ANSWER_CHARS), 0.8);
  assert.equal(MAX_ANSWER_CHARS, 200);
  assert.equal(applyLengthGuard(o), o);
});

test("ยาวเกิน 200: ลด 0.15 และมีหมายเหตุ", () => {
  const out = applyLengthGuard(opt(text(201), 0.7));
  close(out.confidence, 0.55);
  assert.match(out.note, /ยาวเกิน 200/);
});

test("นับอีโมจิเป็น 1 ตัวอักษร", () => {
  const o = opt("😊".repeat(200), 0.8);
  assert.equal(applyLengthGuard(o), o);
});

for (const c of [1, 0.95, 0.9, 0.89, 0.75]) {
  test(`คำตอบยาวที่มั่นใจ ${c}: ต้องต่ำกว่าเกณฑ์ส่งเอง`, () => {
    assert.ok(applyLengthGuard(opt(text(250), c)).confidence < AUTO_SEND_MIN_CONFIDENCE);
  });
}

test("เพดานคำตอบยาวต่ำกว่าเกณฑ์ส่งเอง", () => assert.ok(LONG_ANSWER_MAX_CONFIDENCE < AUTO_SEND_MIN_CONFIDENCE));

test("ความมั่นใจไม่ติดลบ และเก็บหมายเหตุเดิม", () => {
  const out = applyLengthGuard(opt(text(250), 0.1, { note: "ตรวจสอบตัวเลข 5" }));
  assert.equal(out.confidence, 0);
  assert.match(out.note, /ตรวจสอบตัวเลข 5 · คำตอบยาวเกิน/);
});

test("คำตอบดาว: ยกเว้นเมื่อข้อความตรงกัน แม้ช่องว่างต่าง", () => {
  const long = `${text(150)} ${text(150)}`;
  const o = opt(`${text(150)}\n${text(150)}`, 0.9);
  assert.equal(applyLengthGuard(o, [long]), o);
  assert.ok(applyLengthGuard(opt(`${long}เพิ่มเติม`, 0.9), [long]).confidence < 0.75);
});

// ---- การใช้งานจริงใน generateSuggestions ----
test("คำตอบยาวจาก LLM โหมด auto: ไม่ส่งเอง และส่งต่อให้คน", async () => {
  setup("auto");
  replies.next = llmReply([opt(text(250), 0.95)]);
  const s = await incoming();
  await processIncoming(s.conversationId, s.messageId);
  assert.equal(state.tables.messages.filter((m) => m.direction === "out").length, 0);
  assert.equal(state.tables.conversations[0].needs_human, true);
});

test("โหมด auto มีทั้งสั้นและยาว: ส่งคำตอบสั้น", async () => {
  setup("auto");
  replies.next = llmReply([opt(text(250), 0.95), opt("เข็มละ 390 บาทค่ะ", 0.85)]);
  state.tables.knowledge_items = [{ id: "k", category: "ข้อมูลคลินิก", title: "ราคา", content: "390 บาท", updated_at: new Date().toISOString(), active: true }];
  const s = await incoming();
  await processIncoming(s.conversationId, s.messageId);
  assert.deepEqual(state.tables.messages.filter((m) => m.direction === "out").map((m) => m.body), ["เข็มละ 390 บาทค่ะ"]);
});

test("คำตอบดาวยาว ไม่ผ่าน LLM: ไม่ถูกลด ยังเป็น 0.9", async () => {
  const answer = text(250);
  const s = await incoming("คลินิกเปิดกี่โมงคะ");
  state.matchExamples = [{ id: "e", question: "คลินิกเปิดกี่โมง", answer, starred: true, use_count: 0, created_at: "2026-01-01T00:00:00Z", similarity: 0.95 }];
  const r = await generateSuggestions(s.conversationId);
  assert.equal(calls.chat, 0);
  assert.equal(r.options[0].confidence, 0.9);
  assert.equal(r.options[0].note, undefined);
});

test("LLM ยกคำตอบดาวยาวมาตรงๆ: ไม่ถูกลด ส่วนคำตอบยาวที่แต่งเองถูกลด", async () => {
  const answer = text(250);
  const s = await incoming("ราคาคุณภาพของบริการ");
  state.matchExamples = [{ id: "e", question: "ถาม", answer, starred: true, use_count: 0, created_at: "2026-01-01T00:00:00Z", similarity: 0.6 }];
  replies.next = llmReply([opt(answer, 0.9, { source: "example" }), opt(text(260), 0.9)]);
  const r = await generateSuggestions(s.conversationId, { force: true });
  assert.equal(r.options[0].confidence, 0.9);
  assert.ok(r.options[1].confidence < 0.75);
});

// ---- เงื่อนไขการรับบริการ ----
for (const claim of ["ฉีดได้เลยไม่ต้องนัดนะคะ", "ไม่ต้องจองคิวค่ะ", "ไม่ต้องรอคิวค่ะ"]) {
  test(`อ้างเงื่อนไขที่ไม่มีในข้อมูล: ${claim} ไม่ให้ส่งเอง`, () => {
    const out = applyClaimGuard(opt(claim, 1), ["เข็มละ 390 บาท"]);
    assert.ok(out.confidence < AUTO_SEND_MIN_CONFIDENCE);
    assert.match(out.note, /ไม่พบในข้อมูลคลินิก/);
  });
}

test("เงื่อนไขมีในข้อมูลคลินิก: ไม่ลด", () => {
  const o = opt("ฉีดได้เลยค่ะ", 1);
  assert.equal(applyClaimGuard(o, ["วัคซีนนี้ฉีดได้เลย ไม่ต้องจอง"]), o);
});

test("คำตอบทั่วไป: ไม่ลด", () => {
  const o = opt("เข็มละ 390 บาทค่ะ", 1);
  assert.equal(applyClaimGuard(o, []), o);
});

test("AI ลอก ไม่ต้องนัด จากตัวอย่างในโทน โหมด auto: ไม่ส่งเอง", async () => {
  setup("auto");
  state.tables.knowledge_items = [{ id: "k", category: "ข้อมูลคลินิก", title: "ไข้หวัดใหญ่", content: "เข็มละ 390 บาท", updated_at: new Date().toISOString(), active: true }];
  replies.next = llmReply([opt("เข็มละ 390 บาทค่ะ ฉีดได้เลยไม่ต้องนัดนะคะ", 1)]);
  const s = await incoming();
  await processIncoming(s.conversationId, s.messageId);
  assert.equal(state.tables.messages.filter((m) => m.direction === "out").length, 0);
  assert.equal(state.tables.conversations[0].needs_human, true);
});

// ---- few-shot ----
const ex = (answer, starred = false) => ({ answer, starred });

test("เรียงคำตอบเดิม: สั้นและติดดาวก่อน, สั้น, ติดดาวยาว, ยาว", () => {
  const sorted = sortByStyle([ex(text(300)), ex(text(300), true), ex(text(50)), ex(text(40), true), ex(text(20), true), ex(text(10))]);
  assert.deepEqual(sorted.map((e) => [[...e.answer].length, e.starred]), [
    [20, true], [40, true], [10, false], [50, false], [300, true], [300, false],
  ]);
});

test("few-shot สำนวน: เฉพาะติดดาว สั้น ไม่มีลิงก์ ไม่เกิน 3", () => {
  const picked = pickStyleExamples([
    ex("ไม่ติดดาว", false),
    ex(text(121), true),
    ex("ดูแผนที่ https://maps.app.goo.gl/x", true),
    ex("ดาว4 ยาวกว่าอื่น ๆ นิดหน่อยค่ะ", true),
    ex("ดาว1ค่ะ", true),
    ex("ดาวสองค่ะ", true),
    ex("ดาวสามสามค่ะ", true),
  ]);
  assert.deepEqual(picked.map((e) => e.answer), ["ดาว1ค่ะ", "ดาวสองค่ะ", "ดาวสามสามค่ะ"]);
});

test("prompt: มีกฎความยาว แบบตัวเลือก และ few-shot 3 อัน", async () => {
  replies.next = llmReply([opt("ค่ะ")]);
  const s = await incoming();
  await generateSuggestions(s.conversationId);
  const p = calls.lastPrompt;
  assert.match(p, /1–2 ประโยค/);
  assert.match(p, /ยาวสุด 3 บรรทัด/);
  assert.match(p, /ห้ามใช้ bullet หัวข้อ หรือตัวหนา/);
  assert.match(p, /ห้ามทวนคำถาม/);
  assert.match(p, /ห้ามขึ้นต้นด้วยการขอบคุณ/);
  assert.match(p, /ถามกลับได้ครั้งละ 1 คำถาม/);
  assert.match(p, /\(1\) สั้นที่สุด/);
  assert.match(p, /\(2\) คำตอบเดียวกับข้อ 1 แล้วเพิ่มรายละเอียด/);
  assert.match(p, /\(3\) ถามกลับ/);
  assert.match(p, /ไข้หวัดใหญ่เข็มละ 390 บาทค่ะ/);
  assert.equal((p.match(/^- "/gm) ?? []).length, 3);
  assert.match(p, /ห้ามนำราคา เวลา หรือเงื่อนไขในตัวอย่างไปตอบ/);
  assert.match(p, /ความถูกต้องสำคัญกว่าความสั้น/);
  assert.match(p, /ห้ามเดาเงื่อนไขการรับบริการ/);
  assert.ok(!/^- ".*ไม่ต้องนัด/m.test(p), "ตัวอย่างต้องไม่สอนเงื่อนไขที่ไม่มีในข้อมูล");
});

test("prompt: few-shot มีคำตอบดาวของคลินิก แต่ไม่มีคำตอบที่ไม่ติดดาวจากแชทอื่น", async () => {
  state.tables.reply_examples = [
    { id: "1", answer: "คำตอบมาตรฐานค่ะ", starred: true, active: true },
    { id: "2", answer: "คุณสมชายทานยาคุมหรือยังครับ", starred: false, active: true },
    { id: "3", answer: "ปิดใช้แล้วค่ะ", starred: true, active: false },
  ];
  replies.next = llmReply([opt("ค่ะ")]);
  const s = await incoming();
  await generateSuggestions(s.conversationId);
  assert.match(calls.lastPrompt, /- "คำตอบมาตรฐานค่ะ"/);
  assert.ok(!calls.lastPrompt.includes("คุณสมชาย"));
  assert.ok(!calls.lastPrompt.includes("ปิดใช้แล้วค่ะ"));
});

test("ตัวเลขใน few-shot ไม่ยืนยันคำตอบ: AI ลอก 390 บาทจากตัวอย่างต้องถูกตัวกันตัวเลขจับ", async () => {
  replies.next = llmReply([opt("HPV เข็มละ 390 บาทค่ะ", 0.95)]);
  const s = await incoming("HPV ราคาเท่าไหร่");
  const r = await generateSuggestions(s.conversationId);
  assert.ok(r.options[0].confidence <= 0.5);
  assert.match(r.options[0].note, /390/);
});

test("คำตอบดาวของคลินิกใน few-shot ไม่ยืนยันตัวเลข", async () => {
  state.tables.reply_examples = [{ id: "1", answer: "เข็มละ 777 บาทค่ะ", starred: true, active: true }];
  replies.next = llmReply([opt("เข็มละ 777 บาทค่ะ", 0.95)]);
  const s = await incoming();
  const r = await generateSuggestions(s.conversationId);
  assert.ok(r.options[0].confidence <= 0.5);
});

// ---- โทนเริ่มต้น ----
test("ไม่มีค่าในฐานข้อมูล: ใช้โทนใหม่", async () => {
  replies.next = llmReply([opt("ค่ะ")]);
  const s = await incoming();
  await generateSuggestions(s.conversationId);
  assert.ok(calls.lastPrompt.includes(DEFAULT_CLINIC_PROFILE.tone));
  assert.match(DEFAULT_CLINIC_PROFILE.tone, /แอดมิน/);
});

test("มีค่าที่แก้ไว้ในฐานข้อมูล: ใช้ค่านั้น ไม่ใช้ค่าเริ่มต้น", async () => {
  state.tables.settings.push({ key: "clinic_profile", value: { name: "คลินิกทดสอบ", tone: "โทนที่แก้เอง" } });
  replies.next = llmReply([opt("ค่ะ")]);
  const s = await incoming();
  await generateSuggestions(s.conversationId);
  assert.ok(calls.lastPrompt.includes("โทนที่แก้เอง"));
  assert.ok(!calls.lastPrompt.includes(DEFAULT_CLINIC_PROFILE.tone));
});

test("migration เปลี่ยนเฉพาะแถวที่ยังเป็นค่าตั้งต้นเดิม", () => {
  const sql = readFileSync("supabase/migrations/016_default_tone.sql", "utf8");
  assert.match(sql, /value->>'tone' = 'สุภาพ เป็นกันเอง ลงท้ายด้วย ค่ะ อ่านง่ายสำหรับผู้สูงอายุ'/);
  assert.ok(sql.includes(DEFAULT_CLINIC_PROFILE.tone), "ข้อความโทนใน migration ต้องตรงกับค่าเริ่มต้นในโค้ด");
  const seed = readFileSync("supabase/migrations/001_init.sql", "utf8");
  assert.ok(seed.includes("สุภาพ เป็นกันเอง ลงท้ายด้วย ค่ะ อ่านง่ายสำหรับผู้สูงอายุ"));
});

// ---- fromThai ----
test("fromThai: ขอภาษาแชทสั้นๆ แต่ต้องเก็บข้อเท็จจริงและคำแนะนำฉุกเฉินครบ", async () => {
  replies.next = { text: "Flu shot is 390 baht." };
  assert.equal(await fromThai("ไข้หวัดใหญ่เข็มละ 390 บาทค่ะ", "en"), "Flu shot is 390 baht.");
  const p = calls.lastPrompt;
  assert.match(p, /short, casual and polite, not formal/);
  assert.match(p, /Keep every fact and every instruction/);
  assert.match(p, /Keep prices, phone numbers, times/);
});

test("fromThai: ภาษาไทยไม่เรียก LLM", async () => {
  assert.equal(await fromThai("สวัสดีค่ะ", "th"), "สวัสดีค่ะ");
  assert.equal(calls.chat, 0);
});

// ---- ช่องทางเดียวกับที่ลูกค้าคุยอยู่ ----
const LINE_CH = { type: "line", name: "LINE @p49clinic" };
test("ตัวกันช่องทางเดิม: ให้ไอดีหรือบอกให้ติดต่อทางไลน์ถูกลด แต่ 'ทางไลน์นี้' และช่องทางอื่นไม่ถูกลด", () => {
  const flagged = applySameChannelGuard(opt("ขอใบเสนอราคาได้ทาง LINE @p49clinic ค่ะ", 0.9), LINE_CH);
  assert.ok(flagged.confidence <= 0.5);
  assert.match(flagged.note, /คุยอยู่แล้ว/);
  assert.ok(applySameChannelGuard(opt("แอดไลน์คลินิกได้เลยค่ะ", 0.9), LINE_CH).confidence <= 0.5);
  const thisChat = opt("ส่งรายการทางไลน์นี้ได้เลยค่ะ", 0.9);
  assert.equal(applySameChannelGuard(thisChat, LINE_CH), thisChat);
  const web = opt("ขอใบเสนอราคาได้ทาง LINE @p49clinic ค่ะ", 0.9);
  assert.equal(applySameChannelGuard(web, { type: "web", name: "เว็บไซต์ happiwellclinic.com" }), web);
});

test("แชท LINE: พรอมต์บอกช่องทางและกฎข้อความล่าสุด/รูป คำตอบที่ให้ไอดีไลน์ส่งเองไม่ได้", async () => {
  setup("assist", {
    channels: [{ id: "ln", type: "line", name: "LINE @p49clinic", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [{ id: "ct", channel_id: "ln", external_id: "U1", display_name: "ลูกค้าจำลอง", language: "th" }],
    conversations: [{ id: "cv", contact_id: "ct", channel_id: "ln", status: "open", tags: [] }],
    messages: [{ id: "m1", conversation_id: "cv", direction: "in", sender_type: "customer", body: "ตรวจ 7 รายการเท่าไหร่คะ", body_th: null, imported: false, created_at: nextTime() }],
  });
  replies.next = llmReply([opt("ขอใบเสนอราคาได้ทาง LINE @p49clinic ค่ะ", 0.9), opt("ส่งรายการในแชทนี้ได้เลยค่ะ", 0.9)]);
  const r = await generateSuggestions("cv", { force: true });
  assert.match(calls.lastPrompt, /ผ่าน LINE @p49clinic อยู่แล้ว/);
  assert.match(calls.lastPrompt, /ตอบข้อความล่าสุดของลูกค้าเป็นหลัก/);
  assert.match(calls.lastPrompt, /มองไม่เห็นเนื้อหารูป/);
  assert.ok(r.options[0].confidence < AUTO_SEND_MIN_CONFIDENCE);
  assert.equal(r.options[1].confidence, 0.9);
});
