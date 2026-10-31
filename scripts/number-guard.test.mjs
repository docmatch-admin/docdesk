// ทดสอบตัวกันตัวเลขใน suggest.ts: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyNumberGuard, buildNumberSources, extractNumbers, findUnverifiedNumbers, UNVERIFIED_NUMBER_MAX_CONFIDENCE } from "../src/lib/number-guard.ts";

const AUTO_SEND_MIN_CONFIDENCE = 0.75;
const KNOWLEDGE = [
  "เวลาทำการ จันทร์–ศุกร์ 08.00–18.00 น. เสาร์–อาทิตย์ 08.00–12.00 น.",
  "วัคซีน HPV (Gardasil 9) เข็มละ 5,500 บาท",
  "วัคซีนไข้เลือดออก (Qdenga) เข็มละ 1,800 บาท (แบ่งจ่ายได้) หรือคอร์ส 2 เข็ม 3,450 บาท",
];
const SOURCES = { trusted: KNOWLEDGE, customer: [] };
const option = (text) => ({ text, confidence: 1 });

test("เวลาที่แต่งขึ้นถูกลดความมั่นใจจนส่งอัตโนมัติไม่ได้ (เคสจริงจากการทดสอบ)", () => {
  const out = applyNumberGuard(option("วัคซีน HPV เข็มละ 5,500 บาทค่ะ วันเสาร์เปิด 9.00 น. ถึง 17.00 น. ค่ะ"), SOURCES);
  assert.equal(out.confidence, UNVERIFIED_NUMBER_MAX_CONFIDENCE);
  assert.ok(out.confidence < AUTO_SEND_MIN_CONFIDENCE);
  assert.match(out.note, /9:00, 17:00/);
});

test("ราคาที่แต่งขึ้นถูกลดความมั่นใจ", () => {
  const out = applyNumberGuard(option("วัคซีน HPV เข็มละ 4,900 บาทค่ะ"), SOURCES);
  assert.ok(out.confidence < AUTO_SEND_MIN_CONFIDENCE);
  assert.match(out.note, /4900/);
});

test("เลข 9 ใน Gardasil 9 ไม่ทำให้เวลา 9.00 น. ผ่าน", () => {
  assert.deepEqual(findUnverifiedNumbers("เปิด 9.00 น.", SOURCES), ["9:00"]);
});

for (const text of [
  "วันเสาร์เปิด 8:00–12:00 น. ค่ะ",
  "วันเสาร์เปิด 08:00 ถึง 12:00 ค่ะ",
  "วันเสาร์เปิด 8.00–12.00 น. ค่ะ",
  "วันเสาร์เปิด 8 โมง ถึง 12.00 น. ค่ะ",
  "เปิด ๐๘.๐๐ น. ค่ะ",
  "วัคซีนไข้เลือดออกเข็มละ 1800 บาทค่ะ",
  "วัคซีนไข้เลือดออกเข็มละ 1,800.00 บาทค่ะ",
]) {
  test(`ตัวเลขถูกแต่คนละรูปแบบไม่ถูกลดความมั่นใจ: ${text}`, () => {
    const out = applyNumberGuard(option(text), SOURCES);
    assert.equal(out.confidence, 1);
    assert.equal(out.note, undefined);
  });
}

test('ลูกค้าถาม "200 บาทใช่ไหม" แล้ว AI ยืนยัน 200 ต้องถูกจำกัดความมั่นใจ', () => {
  for (const customer of ["วัคซีน HPV 200 บาทใช่ไหม", "วัคซีน HPV 200 ใช่ไหม"]) {
    const out = applyNumberGuard(option("ใช่ค่ะ วัคซีน HPV 200 บาทค่ะ"), { trusted: KNOWLEDGE, customer: [customer] });
    assert.equal(out.confidence, UNVERIFIED_NUMBER_MAX_CONFIDENCE);
    assert.match(out.note, /200/);
  }
});

test("AI เคยตอบเลขผิดในประวัติแล้วตอบเลขเดิมซ้ำ ต้องถูกจำกัดความมั่นใจ", () => {
  const sources = buildNumberSources({
    knowledge: [{ title: "เวลาทำการ", content: KNOWLEDGE[0] }],
    examples: [],
    msgs: [
      { sender_type: "customer", body: "วันเสาร์เปิดกี่โมง ราคาเท่าไหร่คะ", body_th: null },
      { sender_type: "ai", body: "วันเสาร์เปิด 9.00 น. ถึง 17.00 น. ราคา 4,900 บาทค่ะ", body_th: null },
    ],
  });
  const out = applyNumberGuard(option("วันเสาร์เปิด 9.00 น. ถึง 17.00 น. เหมือนเดิมค่ะ ราคา 4,900 บาทค่ะ"), sources);
  assert.equal(out.confidence, UNVERIFIED_NUMBER_MAX_CONFIDENCE);
  assert.match(out.note, /9:00, 17:00, 4900/);
});

test("buildNumberSources: นับคำตอบและข้อความเจ้าหน้าที่ แต่ไม่นับคำถามใน reply_examples", () => {
  const sources = buildNumberSources({
    knowledge: [],
    examples: [{ question: "ได้ยินว่า 777 บาทใช่ไหม", answer: "ราคา 390 บาทค่ะ" }],
    msgs: [{ sender_type: "staff", body: "Open at 14:30", body_th: "เปิด 14.30 น. ค่ะ" }],
  });
  assert.deepEqual(findUnverifiedNumbers("ราคา 390 บาท เปิด 14:30 น. ค่ะ", sources), []);
  assert.deepEqual(findUnverifiedNumbers("ราคา 777 บาทค่ะ", sources), ["777"]);
});

test("เวลาที่ลูกค้าบอกเองไม่นับ แต่คำตอบเดิมและข้อความเจ้าหน้าที่นับ", () => {
  const text = "ตามที่นัดไว้ 14:30 น. ค่าบริการ 250 บาทค่ะ";
  assert.deepEqual(findUnverifiedNumbers(text, { trusted: KNOWLEDGE, customer: ["ขอนัด 14.30 น. นะคะ"] }), ["14:30", "250"]);
  assert.deepEqual(findUnverifiedNumbers(text, {
    trusted: [...KNOWLEDGE, "ค่าบริการ 250 บาทค่ะ", "นัดไว้ 14.30 น. ค่ะ"],
    customer: [],
  }), []);
});

test("จำนวนที่ลูกค้าบอกเอง (ไม่ใช่ราคา/เวลา) ไม่ถูกลดความมั่นใจ", () => {
  const out = applyNumberGuard(option("รับทราบค่ะ มา 3 คน ฉีด 4 เข็มนะคะ"), { trusted: KNOWLEDGE, customer: ["มากัน 3 คน จะฉีด 4 เข็มค่ะ"] });
  assert.equal(out.confidence, 1);
});

test("จำนวนที่ลูกค้าบอกเองใช้ยืนยันราคาหรือเวลาไม่ได้", () => {
  const sources = { trusted: KNOWLEDGE, customer: ["จะฉีด 200 เข็ม มา 10 คนค่ะ"] };
  assert.deepEqual(findUnverifiedNumbers("ราคา 200 บาทค่ะ เปิด 10 โมงค่ะ", sources), ["200", "10:00"]);
});

test("คงหมายเหตุเดิมไว้ และไม่เพิ่มความมั่นใจคำตอบที่ต่ำอยู่แล้ว", () => {
  const out = applyNumberGuard({ text: "ราคา 999 บาท", confidence: 0.2, note: "เดิม" }, { trusted: ["ไม่มีตัวเลข"], customer: [] });
  assert.equal(out.confidence, 0.2);
  assert.match(out.note, /^เดิม · /);
});

test("รูปแบบกลาง", () => {
  const values = (s) => extractNumbers(s).map((t) => t.value);
  assert.deepEqual(values("08.00 8:00 08:00 8 โมง"), ["8:00", "8:00", "8:00", "8:00"]);
  assert.deepEqual(values("1,800 1800 1800.00 12.00 บาท"), ["1800", "1800", "1800", "12"]);
  assert.deepEqual(values("02-000-4586"), ["2", "0", "4586"]);
  assert.deepEqual(extractNumbers("2 เข็ม 390 บาท"), [{ value: "2", kind: "count" }, { value: "390", kind: "price" }]);
});
