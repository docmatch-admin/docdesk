// ทดสอบการซักอาการ: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { storeIncoming, tryAutoSend } = await import("../src/lib/pipeline.ts");
const { generateSuggestions } = await import("../src/lib/suggest.ts");
const {
  applySymptomGuards, findRedFlag, hasEnoughSymptomInfo, hasSymptomSignal, isAskOnly, todayHoursText, unapprovedDosages, hasSelfCareAdvice, URGENT_REPLY, ASK_REPLY,
} = await import("../src/lib/symptom-rules.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
// เวลาทำการ 24 ชม. ทุกวัน / ปิดทุกวัน ใช้สลับในเทสต์
const OPEN_ALL = { tz: "Asia/Bangkok", days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), ["00:00", "23:59"]])) };
const CLOSED_ALL = { tz: "Asia/Bangkok", days: {} };
const DIARRHEA = { id: "g1", category: "แนวทางซักอาการ", title: "ท้องเสีย / อาเจียน", content: "ดูแลตัวเองเบื้องต้น: ดื่มน้ำเกลือแร่ (ORS) จิบบ่อยๆ ถ้าไม่ดีขึ้นใน 2 วัน ควรมาพบแพทย์", active: true, source: "manual" };
const FEVER = { id: "g2", category: "แนวทางซักอาการ", title: "ไข้", content: "ผู้ใหญ่กินพาราเซตามอล 500 มก. ครั้งละ 1–2 เม็ด", active: true, source: "manual" };

function setup({ hours = OPEN_ALL, guides = [] } = {}) {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }, { key: "business_hours", value: hours }],
    channels: [{ id: "ch", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [], conversations: [], tags: [], tag_rules: [], tag_events: [], reply_examples: [], bookings: [],
    knowledge_items: [
      { id: "rights", category: "สิทธิการรักษา", title: "ประกันสังคม", content: "รับสิทธิประกันสังคม", active: true, review_status: "approved", updated_at: nextTime() },
      ...guides.map((g) => ({ updated_at: nextTime(), ...g })),
    ],
    lab_items: [], lab_packages: [],
  });
}
beforeEach(() => setup());

const opt = (text, confidence = 0.9, extra = {}) => ({ text, source: "knowledge", ref_ids: [], confidence, ...extra });
const ask = async (text, reply) => {
  replies.next = { needs_human: false, suggested_tags: [], ...reply };
  const s = await storeIncoming({ channelType: "web", externalId: SESSION, text });
  return { id: s.conversationId, r: await generateSuggestions(s.conversationId, { force: true }) };
};

// ---- คัดกรอง ----
for (const text of ["เจ็บหน้าอก หายใจไม่ออก", "แน่นหน้าอกมากค่ะ", "พ่อปากเบี้ยว แขนขาอ่อนแรง", "ลูกชัก", "หน้าบวม ปากบวม หลังกินยา", "ลูกอายุ 2 เดือน มีไข้", "ทารก 3 สัปดาห์ ตัวร้อน"]) {
  test(`red flag: ${text}`, () => assert.ok(findRedFlag(text)));
}
for (const text of ["ท้องเสีย 2 วัน ไม่มีไข้", "ไอ เจ็บคอ 3 วัน", "ลูกอายุ 2 ขวบ มีไข้", "ลูก 5 เดือน มีไข้ต่ำๆ"]) {
  test(`ไม่ใช่ red flag: ${text}`, () => assert.equal(findRedFlag(text), null));
}

test("สัญญาณอาการ ไม่ติดคำว่าวัคซีนไข้หวัดใหญ่", () => {
  assert.equal(hasSymptomSignal("ป่วย"), true);
  assert.equal(hasSymptomSignal("ท้องเสีย 2 วัน"), true);
  assert.equal(hasSymptomSignal("วัคซีนไข้หวัดใหญ่ราคาเท่าไหร่"), false);
  assert.equal(hasSymptomSignal("ขอไอดีไลน์หน่อย"), false);
});

test("ถามอาการล้วน", () => {
  assert.equal(isAskOnly("เป็นอะไรมาคะ เล่าอาการให้ฟังหน่อยนะคะ"), true);
  assert.equal(isAskOnly("เป็นมากี่วันแล้วคะ มีไข้ไหมคะ"), true);
  assert.equal(isAskOnly("ดื่มน้ำเกลือแร่นะคะ เป็นมากี่วันแล้วคะ"), false);
  assert.equal(isAskOnly("แนะนำโทร 1669 นะคะ"), false);
});

test("คำแนะนำดูแลตัวเอง: คำถามเรื่องยาไม่นับ", () => {
  assert.equal(hasSelfCareAdvice("ดื่มน้ำเกลือแร่จิบบ่อยๆ นะคะ"), true);
  assert.equal(hasSelfCareAdvice("กินยาอะไรไปแล้วบ้างคะ"), false);
});

test("ขนาดยาต้องอยู่ในแนวทางที่อนุมัติ", () => {
  assert.deepEqual(unapprovedDosages("กินพาราเซตามอล 500 มก. ค่ะ", [FEVER.content]), []);
  assert.deepEqual(unapprovedDosages("กินไอบูโพรเฟน 400 mg ค่ะ", [FEVER.content]), ["400 mg"]);
  assert.deepEqual(unapprovedDosages("กินพาราเซตามอล 500 มก. ค่ะ", []), ["500 มก."]);
});

test("เวลาเปิดวันนี้", () => {
  const hours = { tz: "Asia/Bangkok", days: { 1: ["08:00", "18:00"] } };
  assert.equal(todayHoursText(hours, new Date("2026-11-02T03:00:00Z")), "วันนี้ (จันทร์) เปิด 08:00–18:00 น.");
  assert.equal(todayHoursText(hours, new Date("2026-11-03T03:00:00Z")), "วันนี้ (อังคาร) คลินิกปิด");
});

// ---- ตัวกัน ----
const make = (text, confidence, note) => opt(text, confidence, note ? { note } : {});
test("ไม่มี red flag: ตัดตัวเลือกที่พูดถึง 1669", () => {
  const g = applySymptomGuards([opt("เป็นอะไรมาคะ"), opt("โทร 1669 เลยค่ะ")], { redFlag: null, approvedGuides: [], withinHours: true, make });
  assert.deepEqual(g.options.map((o) => o.text), ["เป็นอะไรมาคะ"]);
});

test("red flag: ตัวเลือกแรกเป็น 1669 และต้องให้คนตอบ", () => {
  const g = applySymptomGuards([opt("เป็นมากี่วันแล้วคะ")], { redFlag: "เจ็บหน้าอก", approvedGuides: [], withinHours: false, make });
  assert.equal(g.options[0].text, URGENT_REPLY);
  assert.equal(g.needsHuman, true);
});

test("ยังไม่อนุมัติแนวทาง: ตัดคำแนะนำดูแลตัวเอง เหลือแต่ถามอาการ", () => {
  const g = applySymptomGuards([opt("ดื่มน้ำเกลือแร่จิบบ่อยๆ นะคะ")], { redFlag: null, approvedGuides: [], withinHours: true, make });
  assert.equal(g.options[0].text, ASK_REPLY);
});

test("ความมั่นใจของคำแนะนำไม่เกิน 0.7 แต่คำถามล้วนไม่ถูกลด", () => {
  const g = applySymptomGuards([opt("เป็นมากี่วันแล้วคะ", 0.9), opt("ดื่มน้ำเกลือแร่นะคะ", 0.95)], { redFlag: null, approvedGuides: [DIARRHEA.content], withinHours: false, make });
  assert.equal(g.options[0].confidence, 0.9);
  assert.equal(g.options[1].confidence, 0.7);
});

for (const [label, first, withinHours, expected] of [
  ["ถามล้วน นอกเวลาทำการ: ส่งเองได้", "เป็นมากี่วันแล้วคะ", false, false],
  ["ถามล้วน ในเวลาทำการ: ให้คนตอบ", "เป็นมากี่วันแล้วคะ", true, true],
  ["มีคำแนะนำ นอกเวลาทำการ: ให้คนตอบ", "ดื่มน้ำเกลือแร่นะคะ", false, true],
]) {
  test(`needs_human: ${label}`, () => {
    const g = applySymptomGuards([opt(first)], { redFlag: null, approvedGuides: [DIARRHEA.content], withinHours, make });
    assert.equal(g.needsHuman, expected);
  });
}

// ---- ต่อกับการร่างคำตอบ ----
test("ป่วย: ตัวเลือกแรกเป็นการถามอาการ ไม่ใช่ 1669 และไม่ใช้คำตอบดาว", async () => {
  const { r } = await ask("ป่วยค่ะ", { intent: "symptom", options: [opt("แนะนำโทร 1669 หรือไปโรงพยาบาลค่ะ"), opt("เป็นอะไรมาคะ เล่าอาการให้ฟังหน่อยนะคะ", 0.85, { kind: "ask" })] });
  assert.equal(calls.chat, 1);
  assert.ok(r.options.every((o) => !/1669/.test(o.text)));
  assert.ok(isAskOnly(r.options[0].text));
  assert.match(calls.lastPrompt, /ซักอาการ/);
  assert.match(calls.lastPrompt, /ห้ามให้คำแนะนำดูแลตัวเอง/);
});

test("เจ็บหน้าอก หายใจไม่ออก: แนะนำ 1669 ทันที แม้ AI ไม่ได้บอก", async () => {
  const { r } = await ask("เจ็บหน้าอก หายใจไม่ออก", { intent: "symptom", options: [opt("เป็นมากี่วันแล้วคะ", 0.9, { kind: "ask" })] });
  assert.equal(r.options[0].text, URGENT_REPLY);
  assert.equal(r.needs_human, true);
});

test("ท้องเสีย 2 วัน ไม่มีไข้ (ยังไม่อนุมัติ): ไม่ให้คำแนะนำดูแลตัวเอง และแนวทางร่างไม่อยู่ใน prompt", async () => {
  setup({ guides: [{ ...DIARRHEA, review_status: "draft" }] });
  const { r } = await ask("ท้องเสีย 2 วัน ไม่มีไข้", { intent: "symptom", options: [opt("ดื่มน้ำเกลือแร่ (ORS) จิบบ่อยๆ นะคะ ถ้าไม่ดีขึ้นมาพบแพทย์ค่ะ", 0.9, { kind: "advice" })] });
  assert.ok(r.options.every((o) => !/เกลือแร่/.test(o.text)));
  assert.doesNotMatch(calls.lastPrompt, /จิบบ่อยๆ/);
});

test("ท้องเสีย 2 วัน ไม่มีไข้ (แพทย์อนุมัติแล้ว): ได้คำแนะนำเกลือแร่และชวนมาพบแพทย์ พร้อมเวลาเปิดและสิทธิ", async () => {
  setup({ guides: [{ ...DIARRHEA, review_status: "approved" }] });
  const text = "ดื่มน้ำเกลือแร่ (ORS) จิบบ่อยๆ นะคะ ถ้าไม่ดีขึ้นใน 2 วันมาพบแพทย์ได้ค่ะ วันนี้เปิดถึง 23.59 น. ใช้สิทธิประกันสังคมได้ค่ะ";
  const { r } = await ask("ท้องเสีย 2 วัน ไม่มีไข้", { intent: "symptom", options: [opt(text, 0.9, { kind: "advice" })] });
  assert.match(r.options[0].text, /เกลือแร่/);
  assert.match(r.options[0].text, /พบแพทย์/);
  assert.equal(r.options[0].confidence, 0.7);
  assert.equal(r.needs_human, true);
  assert.match(calls.lastPrompt, /จิบบ่อยๆ/);
  assert.match(calls.lastPrompt, /รับสิทธิประกันสังคม/);
  assert.match(calls.lastPrompt, /## เวลาเปิดวันนี้\nวันนี้/);
});

test("ถามล้วนนอกเวลาทำการ: AI ส่งเองได้", async () => {
  setup({ hours: CLOSED_ALL });
  const { id, r } = await ask("ไม่สบายค่ะ", { intent: "symptom", options: [opt("เป็นอะไรมาคะ มีไข้ไหมคะ", 0.9, { kind: "ask" })] });
  assert.equal(r.needs_human, false);
  assert.equal(await tryAutoSend(id, r.options, r.needs_human, r.id), true);
});

test("ถามล้วนในเวลาทำการ: AI ไม่ส่งเอง", async () => {
  const { id, r } = await ask("ไม่สบายค่ะ", { intent: "symptom", options: [opt("เป็นอะไรมาคะ มีไข้ไหมคะ", 0.9, { kind: "ask" })] });
  assert.equal(r.needs_human, true);
  assert.equal(await tryAutoSend(id, r.options, r.needs_human, r.id), false);
});

test("migration: ร่างไม่ถูกค้นเจอ และ seed ครบ 8 หัวข้อเป็นร่าง", () => {
  const sql = readFileSync("supabase/migrations/031_symptom_guides.sql", "utf8");
  assert.match(sql, /where k\.active and k\.review_status = 'approved'/);
  const titles = [...sql.matchAll(/^\('([^']+)',$/gm)].map((m) => m[1]);
  assert.deepEqual(titles, ["ไข้ / ไข้หวัด", "ไอ เจ็บคอ", "ท้องเสีย / อาเจียน", "ปวดหัว", "ผื่นคัน", "ปวดกล้ามเนื้อ / ข้อเท้าพลิก", "ปัสสาวะแสบขัด", "Red flag รวม"]);
  assert.match(sql, /select 'แนวทางซักอาการ', v\.title, v\.content, 'draft'/);
});

test("แก้แนวทางแล้วกลับเป็นร่าง และมีปุ่มแพทย์อนุมัติ", () => {
  const api = readFileSync("src/app/api/knowledge/route.ts", "utf8");
  assert.match(api, /guide \? \{ review_status: "draft"/);
  const ui = readFileSync("src/app/(staff)/knowledge/knowledge-client.tsx", "utf8");
  assert.match(ui, /ต้องให้แพทย์ตรวจทาน/);
  assert.match(ui, /แพทย์อนุมัติแล้ว<\/button>/);
});

test("ข้อมูลพอ: รู้ระยะเวลาและไข้หรือความรุนแรง", () => {
  assert.equal(hasEnoughSymptomInfo("ท้องเสีย 2 วัน ไม่มีไข้"), true);
  assert.equal(hasEnoughSymptomInfo("ท้องเสียค่ะ"), false);
  assert.equal(hasEnoughSymptomInfo("ท้องเสีย 2 วัน"), false);
});

test("ท้องเสีย 2 วัน ไม่มีไข้ (อนุมัติแล้ว): AI ถามก่อน แต่ระบบเรียงคำแนะนำขึ้นก่อน", async () => {
  setup({ guides: [{ ...DIARRHEA, review_status: "approved" }] });
  const { r } = await ask("ท้องเสีย 2 วัน ไม่มีไข้", { intent: "symptom", options: [
    opt("ถ่ายเหลวกี่ครั้งต่อวันคะ", 0.9, { kind: "ask" }),
    opt("ดื่มน้ำเกลือแร่ (ORS) จิบบ่อยๆ นะคะ ถ้าไม่ดีขึ้นใน 2 วันมาพบแพทย์ค่ะ", 0.9, { kind: "advice" }),
  ] });
  assert.match(r.options[0].text, /เกลือแร่/);
  assert.equal(r.needs_human, true);
});

test("ข้อมูลยังไม่พอ: คำถามยังขึ้นก่อน แม้มีแนวทางอนุมัติ", async () => {
  setup({ guides: [{ ...DIARRHEA, review_status: "approved" }] });
  const { r } = await ask("ท้องเสียค่ะ", { intent: "symptom", options: [
    opt("เป็นมากี่วันแล้วคะ มีไข้ไหมคะ", 0.9, { kind: "ask" }),
    opt("ดื่มน้ำเกลือแร่ (ORS) จิบบ่อยๆ นะคะ", 0.9, { kind: "advice" }),
  ] });
  assert.match(r.options[0].text, /กี่วัน/);
});
