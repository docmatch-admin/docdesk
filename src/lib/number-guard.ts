/** ความมั่นใจสูงสุดของคำตอบที่มีตัวเลขซึ่งไม่พบในข้อมูล (ต้องต่ำกว่า AUTO_SEND_MIN_CONFIDENCE) */
export const UNVERIFIED_NUMBER_MAX_CONFIDENCE = 0.5;

const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
const TIME_UNITS = ["โมง", "นาฬิกา", "น."];
const PRICE_UNITS = ["บาท", "baht", "฿"];
/** หน่วยนับที่เชื่อตามลูกค้าได้ (ไม่ใช่ราคา/เวลา) */
const COUNT_UNITS = ["เข็ม", "คน", "ท่าน", "ครั้ง", "ชุด", "ซอง", "ขวบ", "ปี", "เดือน", "สัปดาห์", "วัน"];

export type NumberKind = "time" | "price" | "count" | "other";
export interface NumberToken { value: string; kind: NumberKind }

/** แหล่งตัวเลข: trusted = ฐานข้อมูล/คำตอบเจ้าหน้าที่, customer = ข้อความลูกค้า (เชื่อเฉพาะหน่วยนับ) */
export interface NumberSources { trusted: string[]; customer: string[] }

/** ไม่รวมข้อความที่ AI เคยส่ง และคำถามใน reply_examples ซึ่งเป็นคำพูดลูกค้า */
export function buildNumberSources(input: {
  knowledge: { title: string; content: string }[];
  examples: { answer: string }[];
  msgs: { sender_type: string; body: string; body_th: string | null }[];
}): NumberSources {
  const textsFrom = (senderType: string) =>
    input.msgs.filter((m) => m.sender_type === senderType).flatMap((m) => [m.body, m.body_th ?? ""]);
  return {
    trusted: [
      ...input.knowledge.map((k) => `${k.title} ${k.content}`),
      ...input.examples.map((e) => e.answer),
      ...textsFrom("staff"),
    ],
    customer: textsFrom("customer"),
  };
}

const unitPattern =[...TIME_UNITS, ...PRICE_UNITS, ...COUNT_UNITS].map((u) => u.replace(".", "\\.")).join("|");

/**
 * ดึงตัวเลขจากข้อความเป็นรูปแบบกลางเพื่อเทียบกัน
 * - เวลา: 08.00 = 8:00 = 08:00 = 8 โมง = "8:00"
 * - ราคา: 1,800 = 1800 = 1800.00 = "1800"
 * เวลาแยกจากจำนวนเต็ม ("9.00 น." ไม่นับว่าตรงกับเลข 9 ใน "Gardasil 9")
 */
export function extractNumbers(text: string): NumberToken[] {
  const s = text
    .replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)))
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1");

  const found: NumberToken[] = [];
  const re = new RegExp(`(?<![\\d.:])(\\d+)(?:[.:](\\d+))?(?![\\d:])(?:\\s*(${unitPattern}))?`, "gi");
  for (const [, whole, frac, rawUnit] of s.matchAll(re)) {
    const unit = rawUnit?.toLowerCase();
    const h = Number(whole);
    const isPrice = !!unit && PRICE_UNITS.includes(unit);
    const isTimeUnit = !!unit && TIME_UNITS.includes(unit) && h <= 24;
    const isTimeShape = frac?.length === 2 && whole.length <= 2 && h <= 24 && Number(frac) < 60;
    if (!isPrice && (isTimeShape || (!frac && isTimeUnit))) {
      found.push({ value: `${h}:${frac ?? "00"}`, kind: "time" });
      continue;
    }
    const f = frac?.replace(/0+$/, "");
    found.push({
      value: f ? `${h}.${f}` : whole.replace(/^0+(?=\d)/, ""),
      kind: isPrice ? "price" : unit && COUNT_UNITS.includes(unit) ? "count" : "other",
    });
  }
  return found;
}

/**
 * ตัวเลขในคำตอบที่ยืนยันไม่ได้
 * ราคา/เวลาต้องมาจาก trusted เท่านั้น กัน AI ยืนยันเลขที่ลูกค้าเดามา หรือเลขผิดที่ AI เคยตอบ
 * ข้อความลูกค้าใช้ยืนยันได้เฉพาะจำนวนที่มีหน่วยนับ เช่น "2 เข็ม"
 */
export function findUnverifiedNumbers(text: string, sources: NumberSources): string[] {
  const trusted = new Set(sources.trusted.flatMap(extractNumbers).map((t) => t.value));
  const customerCounts = new Set(
    sources.customer.flatMap(extractNumbers).filter((t) => t.kind === "count").map((t) => t.value),
  );
  const unverified = extractNumbers(text)
    .filter((t) => !trusted.has(t.value))
    .filter((t) => t.kind === "time" || t.kind === "price" || !customerCounts.has(t.value))
    .map((t) => t.value);
  return [...new Set(unverified)];
}

/** ราคา/เวลาที่ไม่มีในข้อมูล = AI อาจแต่งเอง → ลดความมั่นใจเพื่อไม่ให้ส่งอัตโนมัติ */
export function applyNumberGuard<T extends { text: string; confidence: number; note?: string }>(
  option: T,
  sources: NumberSources,
): T {
  const unverified = findUnverifiedNumbers(option.text, sources);
  if (!unverified.length) return option;
  const warning = `ตรวจสอบตัวเลข ${unverified.join(", ")} (ไม่พบในข้อมูลคลินิก)`;
  return {
    ...option,
    confidence: Math.min(option.confidence, UNVERIFIED_NUMBER_MAX_CONFIDENCE),
    note: option.note ? `${option.note} · ${warning}` : warning,
  };
}
