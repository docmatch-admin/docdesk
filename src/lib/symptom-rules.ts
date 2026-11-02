import type { BusinessHours } from "./mode";

/** หมวดแนวทางซักอาการใน knowledge_items ต้องให้แพทย์อนุมัติก่อน AI ใช้ */
export const SYMPTOM_GUIDE_CATEGORY = "แนวทางซักอาการ";

/**
 * red flag ทั่วไป ใช้ได้ตั้งแต่ยังไม่มีแนวทางที่อนุมัติ โค้ดตรวจเองไม่รอ AI
 * คำสั้นอย่าง "ซึม" ยอมให้ติดเกินดีกว่าพลาด เพราะผลคือให้คนตอบ
 */
const RED_FLAG_WORDS = [
  "เจ็บหน้าอก", "แน่นหน้าอก", "หายใจไม่ออก", "หายใจลำบาก", "หายใจไม่ทัน", "หอบเหนื่อย",
  "หมดสติ", "ไม่รู้สึกตัว", "เป็นลม", "ซึม", "เรียกไม่ตื่น", "ชัก",
  "ปากเบี้ยว", "หน้าเบี้ยว", "แขนขาอ่อนแรง", "แขนอ่อนแรง", "ขาอ่อนแรง", "อ่อนแรงครึ่งซีก", "พูดไม่ชัด", "พูดไม่ได้",
  "เลือดออกมาก", "เลือดไม่หยุด", "อาเจียนเป็นเลือด", "ไอเป็นเลือด", "ถ่ายเป็นเลือด", "ถ่ายดำ",
  "ปวดท้องรุนแรง", "ปวดท้องมาก", "ปวดท้องอย่างรุนแรง",
  "หน้าบวม", "ปากบวม", "ตาบวม", "คอบวม", "ลิ้นบวม", "แพ้รุนแรง", "ผื่นขึ้นทั้งตัว",
  "ปวดหัวรุนแรง", "ปวดหัวมากที่สุด", "คอแข็ง",
];
const BABY = /ทารก|ลูก|เด็ก|น้อง|baby|infant/i;
const AGE = /(\d+)\s*(วัน|สัปดาห์|อาทิตย์|เดือน)/g;

/** ไข้ในเด็กอายุต่ำกว่า 3 เดือน */
function feverInYoungInfant(text: string): boolean {
  if (!/ไข้|ตัวร้อน/.test(text) || !BABY.test(text)) return false;
  for (const [, n, unit] of text.matchAll(AGE)) {
    const days = Number(n) * (unit === "วัน" ? 1 : unit === "เดือน" ? 30 : 7);
    if (days < 90) return true;
  }
  return false;
}

export function findRedFlag(text: string): string | null {
  const word = RED_FLAG_WORDS.find((w) => text.includes(w));
  if (word) return word;
  return feverInYoungInfant(text) ? "ไข้ในเด็กอายุต่ำกว่า 3 เดือน" : null;
}

const SYMPTOM_WORDS = [
  "ป่วย", "ไม่สบาย", "อาการ", "ไข้", "ตัวร้อน", "ไอ", "เจ็บคอ", "น้ำมูก", "ท้องเสีย", "ถ่ายเหลว", "อาเจียน", "คลื่นไส้",
  "ปวด", "เจ็บ", "ผื่น", "คัน", "บวม", "ข้อเท้าพลิก", "แพลง", "ปัสสาวะแสบ", "ฉี่แสบ", "ปัสสาวะขัด", "เวียนหัว", "มึนหัว",
  "หายใจ", "แน่น", "ชัก", "ซึม",
];
// คำที่มีคำอาการซ้อนอยู่แต่ไม่ใช่อาการ
const NOT_SYMPTOM = /ไอดี|ไอจี|ไอโฟน|ไอศกรีม|วัคซีนไข้|ไข้หวัดใหญ่\s*\d|ค่าบริการ/g;

export const hasSymptomSignal = (text: string) => {
  const s = text.replace(NOT_SYMPTOM, "");
  return SYMPTOM_WORDS.some((w) => s.includes(w));
};

/** คำแนะนำการดูแลหรือการรักษา: ระหว่างแนวทางยังไม่อนุมัติห้ามมี และคำตอบแบบนี้ไม่ใช่การซักอาการล้วน */
const ADVICE = /ยา|กิน|ทาน|ดื่ม|พัก|ประคบ|เช็ดตัว|ทา(?!ง)|เกลือแร่|ORS|ล้าง|นอน|หลีกเลี่ยง|งด|ควร/i;
const ASKS = /\?|？|ไหม|มั้ย|หรือเปล่า|หรือยัง|กี่|อะไร|ยังไง|อย่างไร|เท่าไ[รห]|ไหน|บ้าง|เล่า/;
const DOSAGE = /\d[\d.,]*\s*(มก\.?|มิลลิกรัม|mg|มล\.?|ml|ซีซี|cc|เม็ด|ช้อน|แคปซูล)/gi;

const SELF_CARE = /ยา|ดื่ม|ทาน|กิน|ประคบ|เช็ดตัว|เกลือแร่|ORS|พักผ่อน|กลั้วคอ|ทา(?!ง)/i;

/** มีประโยคแนะนำการดูแลตัวเอง ประโยคที่เป็นคำถามอย่าง "กินยาอะไรไปบ้างคะ" ไม่นับ */
export const hasSelfCareAdvice = (text: string) =>
  text.split(/\n|ค่ะ|นะคะ|ครับ|[.!?？]/).some((s) => SELF_CARE.test(s) && !ASKS.test(s));

export const mentions1669 =(text: string) => /1669/.test(text.replace(/[๐-๙]/g, (d) => String("๐๑๒๓๔๕๖๗๘๙".indexOf(d))));
export const hasAdvice = (text: string) => ADVICE.test(text) || mentions1669(text) || /โรงพยาบาล/.test(text);

/** ถามอาการล้วน ไม่มีคำแนะนำทางการแพทย์ ส่งเองได้นอกเวลาทำการ */
export const isAskOnly = (text: string) => ASKS.test(text) && !hasAdvice(text);

/** ขนาดยาในคำตอบที่ไม่มีอยู่ในแนวทางที่อนุมัติ */
export function unapprovedDosages(text: string, approvedGuides: string[]): string[] {
  const norm = (s: string) => s.replace(/\s+/g, "").replace(/,/g, "").toLowerCase();
  const allowed = approvedGuides.map(norm).join("\n");
  return [...text.matchAll(DOSAGE)].map((m) => m[0]).filter((d) => !allowed.includes(norm(d)));
}

const DURATION = /\d+\s*(วัน|ชั่วโมง|ชม|สัปดาห์|อาทิตย์|เดือน)|เมื่อวาน|เมื่อคืน|ตั้งแต่|เช้านี้|วันนี้/;
const SEVERITY = /ไข้|ตัวร้อน|รุนแรง|มาก|นิดหน่อย|เล็กน้อย|นิดเดียว|ไม่หนัก|หนัก|\d+(\.\d+)?\s*องศา/;

/** รู้ระยะเวลาและไข้หรือความรุนแรงแล้ว ถือว่าซักพอสำหรับคำแนะนำเบื้องต้น ไม่ให้ AI ถามวนต่อ */
export const hasEnoughSymptomInfo = (customerText: string) => DURATION.test(customerText) && SEVERITY.test(customerText);

export const URGENT_REPLY = "อาการแบบนี้อาจเป็นภาวะฉุกเฉินนะคะ แนะนำโทร 1669 หรือไปโรงพยาบาลใกล้บ้านทันทีค่ะ ถ้าไปเองได้อย่าขับรถเองนะคะ 🙏";
export const ASK_REPLY = "เป็นอะไรมาคะ เล่าอาการให้ฟังหน่อยนะคะ เป็นมากี่วันแล้วคะ";

/** ความมั่นใจสูงสุดของคำตอบเรื่องอาการที่มีคำแนะนำ */
export const SYMPTOM_MAX_CONFIDENCE = 0.7;

const DAY_NAMES = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

/** "วันนี้ (จันทร์) เปิด 08:00–18:00 น." จากค่าตั้งเวลาทำการ */
export function todayHoursText(hours: BusinessHours, now = new Date()): string {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: hours.tz || "Asia/Bangkok", weekday: "short" }).format(now);
  const idx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  const range = hours.days?.[String(idx)];
  return range ? `วันนี้ (${DAY_NAMES[idx]}) เปิด ${range[0]}–${range[1]} น.` : `วันนี้ (${DAY_NAMES[idx]}) คลินิกปิด`;
}

export function symptomPromptRules(approved: boolean): string {
  return `- เรื่องอาการป่วย: intent = "symptom" ทำหน้าที่ซักอาการและช่วยคนไข้ก่อน ห้ามผลักไปคลินิกหรือ 1669 ทันที น้ำเสียงอบอุ่น ห่วงใย เช่น "เป็นอะไรมาคะ เล่าอาการให้ฟังหน่อยนะคะ"
  - ข้อมูลพอ = รู้อาการหลัก เป็นมากี่วัน และมีไข้หรือความรุนแรงแค่ไหนแล้ว (อายุ ตั้งครรภ์ โรคประจำตัว แพ้ยา ถามต่อท้ายคำแนะนำได้ 1 คำถาม ไม่ต้องรอ)
  - ข้อมูลอาการยังไม่พอ: ตัวเลือกแรกเป็นการถามอาการ 1–2 คำถามต่อครั้ง ตามลำดับ อาการหลัก → เป็นมากี่วัน → ไข้/ความรุนแรง → อายุ/ตั้งครรภ์ → โรคประจำตัว/แพ้ยา ห้ามถามซ้ำสิ่งที่คนไข้บอกแล้วในประวัติแชท ตัวเลือกที่เป็นการถามล้วนตั้ง kind = "ask"
  - red flag (เช่น เจ็บหน้าอก หายใจลำบาก ซึม/หมดสติ ชัก ปากเบี้ยว แขนขาอ่อนแรง เลือดออกมาก ไข้ในเด็กอายุต่ำกว่า 3 เดือน ปวดท้องรุนแรง แพ้รุนแรง/หน้าบวม): ตั้ง red_flag = true และแนะนำโทร 1669 หรือไปโรงพยาบาลทันที ถ้าไม่พบ red flag ห้ามพูดถึง 1669
${approved
    ? `  - ข้อมูลพอแล้ว: ตัวเลือกแรกต้องเป็นคำแนะนำดูแลตัวเองเบื้องต้นจาก "แนวทางซักอาการ" ที่ให้เท่านั้น แล้วชวนมาพบแพทย์ถ้าไม่ดีขึ้น พร้อมเวลาเปิดวันนี้ สิทธิที่ใช้ได้ และเสนอจองคิว kind = "advice" ห้ามถามซ้ำสิ่งที่รู้แล้ว`
    : `  - ยังไม่มีแนวทางที่แพทย์อนุมัติ: ห้ามให้คำแนะนำดูแลตัวเองหรือเรื่องยา ข้อมูลพอแล้วให้ชวนมาพบแพทย์ พร้อมเวลาเปิดวันนี้ สิทธิที่ใช้ได้ และเสนอจองคิว`}
  - ห้ามวินิจฉัย ห้ามบอกชื่อยาที่ต้องสั่งโดยแพทย์ ห้ามบอกขนาดยา ยกเว้นยาสามัญประจำบ้านที่ระบุใน "แนวทางซักอาการ" เท่านั้น`;
}

export interface SymptomOption { text: string; confidence: number; note?: string }

/**
 * ตัวกันความปลอดภัยของคำตอบเรื่องอาการ โค้ดตัดสินเอง ไม่เชื่อ AI อย่างเดียว
 * คืนตัวเลือกที่ผ่าน และเหตุผลที่ต้องให้คนตอบ
 */
export function applySymptomGuards<T extends SymptomOption>(
  options: T[],
  input: { redFlag: string | null; approvedGuides: string[]; withinHours: boolean; enoughInfo?: boolean; make: (text: string, confidence: number, note?: string) => T },
): { options: T[]; needsHuman: boolean } {
  const { redFlag, approvedGuides } = input;
  const note = (o: T, warning: string): T => ({ ...o, note: o.note ? `${o.note} · ${warning}` : warning });
  let out = options
    // ไม่มี red flag: ห้ามพูดถึง 1669
    .filter((o) => redFlag || !mentions1669(o.text))
    // ยังไม่มีแนวทางที่แพทย์อนุมัติ: ห้ามคำแนะนำดูแลตัวเอง
    .filter((o) => approvedGuides.length || !hasSelfCareAdvice(o.text))
    .map((o) => {
      const doses = unapprovedDosages(o.text, approvedGuides);
      if (doses.length) return note({ ...o, confidence: 0 }, `ขนาดยา ${doses.join(", ")} ไม่อยู่ในแนวทางที่แพทย์อนุมัติ`);
      return isAskOnly(o.text) ? o : { ...o, confidence: Math.min(o.confidence, SYMPTOM_MAX_CONFIDENCE) };
    });
  // ข้อมูลพอและมีแนวทางที่อนุมัติ: คำแนะนำดูแลตัวเองขึ้นก่อน
  if (!redFlag && input.enoughInfo && approvedGuides.length) {
    const advice = out.find((o) => hasSelfCareAdvice(o.text) && o.confidence > 0);
    if (advice) out = [advice, ...out.filter((o) => o !== advice)];
  }
  if (redFlag) {
    out = [input.make(URGENT_REPLY, SYMPTOM_MAX_CONFIDENCE, `พบสัญญาณอันตราย: ${redFlag}`), ...out.filter((o) => mentions1669(o.text) || isAskOnly(o.text))];
  }
  if (!out.length) out = [input.make(ASK_REPLY, 0.8)];
  // ถามอาการล้วนส่งเองได้นอกเวลาทำการเท่านั้น
  const askFirst = !redFlag && isAskOnly(out[0].text);
  return { options: out.slice(0, 3), needsHuman: !(askFirst && !input.withinHours) };
}
