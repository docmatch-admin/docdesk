// ข้อความนัดตามภาษาของลูกค้า: แปลครั้งเดียวต่อภาษาแล้วเก็บไว้ · npm test
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { resetDb, state } = await import(fake("admin"));
const rules = await import("../src/lib/appointment-rules.ts");
const { languagePack } = await import("../src/lib/appointment-language.ts");

const settings = rules.normalizeAppointmentSettings({});
const appt = { id: "a1", patient_name: "Li Wei", appoint_date: "2026-11-20", time_mode: "exact", time_start: "09:30", time_end: null,
  purpose_text: "ฟังผลแล็บ", instructions: "งดอาหาร 8 ชั่วโมง" };

beforeEach(() => { reset(); resetDb({ appointment_translations: [], slip_translations: [] }); });

const zhItems = () => Object.fromEntries([...Object.entries(rules.EN_PHRASES), ["template", settings.template_en]]
  .map(([k, v]) => [k, `中文:${v}`]));

test("เลือกภาษา: ไทย/ไม่รู้ภาษา = ไทย · ภาษาอื่นทุกภาษา = ฉบับต่างประเทศ", () => {
  assert.equal(rules.pickLanguage(null), "th");
  assert.equal(rules.pickLanguage("th"), "th");
  assert.equal(rules.pickLanguage("en"), "en");
  assert.equal(rules.pickLanguage("zh"), "en");
});

test("ภาษาใหม่: แปลชุดวลีครั้งเดียว เก็บไว้ ครั้งต่อไปไม่เรียก AI · ไม่ส่งชื่อคนไข้ให้ AI", async () => {
  replies.next = { items: zhItems() };
  const pack = await languagePack("zh", settings);
  assert.equal(calls.chat, 1);
  assert.equal(pack.lang, "zh");
  assert.equal(pack.phrases["header.reminder"], `中文:${rules.EN_PHRASES["header.reminder"]}`);
  assert.equal(state.tables.appointment_translations.length, 1);
  const text = rules.appointmentText({ kind: "reminder", lang: "en", appointment: appt, settings, clinicName: "HappiWell", includePurpose: false, pack });
  assert.match(text, /^中文:⏰/);
  assert.match(text, /Li Wei/, "ชื่อเติมหลังแปล");
  assert.match(text, /2026/, "วันที่ตาม locale");
  assert.doesNotMatch(calls.lastPrompt, /Li Wei/);
  // ครั้งต่อไป ใช้ที่เก็บไว้
  reset();
  const again = await languagePack("zh", settings);
  assert.equal(calls.chat, 0);
  assert.equal(again.phrases["button.confirm"], `中文:Confirm`);
});

test("คำแปลที่ตัวแปรหายหรือตัวเลขไม่ครบ ใช้ภาษาอังกฤษแทนเฉพาะวลีนั้น · AI ล่ม = อังกฤษทั้งชุด", async () => {
  const items = zhItems();
  items.previous = "之前"; // {date} {time} หาย
  replies.next = { items };
  const pack = await languagePack("zh", settings);
  assert.equal(pack.phrases.previous, rules.EN_PHRASES.previous);
  assert.equal(pack.phrases["label.tel"], "中文:Tel");
  resetDb({ appointment_translations: [], slip_translations: [] });
  calls.failNext = new Error("down");
  const fallback = await languagePack("ja", settings);
  assert.equal(fallback.lang, "en");
  assert.equal(fallback.phrases["header.new"], rules.EN_PHRASES["header.new"]);
});

test("ข้อความที่เจ้าหน้าที่พิมพ์ แปลครั้งเดียวต่อข้อความต่อภาษา และใช้แทนต้นฉบับไทยในข้อความนัด", async () => {
  replies.next = { items: { "1": "Lab results", "2": "No food for 8 hours" } };
  const en = await languagePack("en", settings, { purpose: appt.purpose_text, instructions: appt.instructions });
  assert.equal(en.texts.purpose_text, "Lab results");
  const text = rules.appointmentText({ kind: "new", lang: "en", appointment: appt, settings, clinicName: "HappiWell", includePurpose: true, pack: en });
  assert.match(text, /Purpose: Lab results/);
  assert.match(text, /Before your visit: No food for 8 hours/);
  assert.doesNotMatch(text, /ฟังผลแล็บ/);
});

test("ปุ่มและข้อความตอบหลังกดปุ่มตามภาษา", async () => {
  replies.next = { items: zhItems() };
  const pack = await languagePack("zh", settings);
  assert.equal(rules.replyFor("en", pack, "confirmed"), `中文:${rules.EN_PHRASES["reply.confirmed"]}`);
  assert.equal(rules.replyFor("th", null, "confirmed"), rules.REPLY_TEXT.th.confirmed);
  const flex = rules.appointmentFlex({ kind: "new", lang: "en", appointment: appt, settings, clinicName: "HappiWell", includePurpose: false, pack });
  assert.equal(flex.contents.footer.contents[0].action.label, "中文:Confirm");
});
