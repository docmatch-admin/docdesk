import { ITEM_ALIASES } from "./lab-pricing";
import { extractNumbers } from "./number-guard";

/** ข้อความนำของบริการที่เว็บไม่มีราคา ใช้ทั้งบอก AI และให้โค้ดรู้ว่าห้ามมีตัวเลขราคา */
export const NO_PRICE_MARK = "ไม่มีราคาบนเว็บ ห้ามบอกหรือเดาตัวเลขราคา ให้ตอบตามนี้:";

export interface PriceEntry {
  name: string;
  /** คำที่ใช้จับชื่อบริการในข้อความ ตัวพิมพ์เล็ก */
  names: string[];
  prices: number[];
  /** บริการไม่มีราคา: ทุกตัวเลขราคาถือว่าผิด */
  noPrice: boolean;
  /** ข้อความแทนราคาจากเว็บ */
  note: string | null;
}

/** ชื่อที่ลูกค้าเรียกจริง ชื่อบนเว็บมักยาวกว่า */
const WEBSITE_ALIASES: Record<string, string[]> = {
  "flu-vaccine": ["ไข้หวัดใหญ่"],
  "pneumococcal-vaccine-prevnar-20": ["prevnar", "ปอดอักเสบ", "pcv20"],
  "hepatitis-b-vaccine": ["วัคซีนตับอักเสบบี", "วัคซีนไวรัสตับอักเสบ"],
  "tetanus-vaccine": ["บาดทะยัก"],
  "rabies-vaccine": ["พิษสุนัขบ้า"],
  "hpv-vaccine-gardasil-9": ["hpv", "gardasil", "การ์ดาซิล"],
  "dengue-vaccine-qdenga": ["qdenga", "ไข้เลือดออก"],
  "rsv-vaccine-abrysvo": ["rsv", "abrysvo"],
  "contraceptive-injection-3-month": ["ยาคุม 3 เดือน", "ยาฉีดคุม 3 เดือน", "ฉีดคุม 3 เดือน", "ยาฉีดคุมกำเนิด 3 เดือน", "dmpa"],
  "contraceptive-injection-monthly": ["ยาคุมรายเดือน", "ยาฉีดคุมรายเดือน", "ฉีดคุมรายเดือน", "ยาฉีดคุมกำเนิดรายเดือน"],
  "medical-certificate": ["ใบรับรองแพทย์"],
  "driving-licence-medical-certificate": ["ใบรับรองแพทย์ใบขับขี่"],
  ekg: ["ekg", "คลื่นไฟฟ้าหัวใจ"],
  nebulizer: ["พ่นยา", "nebulizer"],
  "wound-care": ["ทำแผล", "ล้างแผล", "เย็บแผล"],
  "health-checkup-basic": ["ชุดเล็ก"],
  "health-checkup-male": ["ชุดใหญ่"],
  "health-checkup-female": ["ชุดใหญ่"],
  "employee-health-checkup": ["ตรวจสุขภาพพนักงาน", "ตรวจสุขภาพบริษัท"],
  "work-permit-health-check": ["แรงงานต่างด้าว", "ใบอนุญาตทำงาน"],
  "std-screening": ["โรคติดต่อทางเพศ", "ตรวจ std", "ตรวจกามโรค"],
  "pep-prep": ["pep", "prep", "เป๊ป", "เพร็พ"],
};

const moneyIn = (text: string) =>
  extractNumbers(text).filter((t) => t.kind !== "time").map((t) => Number(t.value)).filter((n) => Number.isFinite(n));

export interface WebsitePriceRow { website_slug: string | null; title: string; content: string }
export interface LabPriceRow { code: string; name_en: string; name_th: string; price: number | null }
export interface PackagePriceRow { name: string; price: number }

/** รวมราคาที่ยอมรับได้ ทุกตัวมาจาก knowledge_items และตารางแล็บเท่านั้น */
export function buildPriceEntries(website: WebsitePriceRow[], items: LabPriceRow[], packages: PackagePriceRow[]): PriceEntry[] {
  const entries: PriceEntry[] = [];
  for (const row of website) {
    const noPrice = row.content.startsWith(NO_PRICE_MARK);
    const note = noPrice ? row.content.slice(NO_PRICE_MARK.length).split("\n")[0].trim() : null;
    entries.push({
      name: row.title,
      names: [row.title.toLowerCase(), ...(WEBSITE_ALIASES[row.website_slug ?? ""] ?? [])],
      // ตัดรายการที่รวมออก เลขในนั้นเป็นจำนวนค่าตรวจ ไม่ใช่ราคา
      prices: noPrice ? [] : moneyIn(row.content.split("\nรวม:")[0]),
      noPrice,
      note,
    });
  }
  for (const item of items) {
    if (item.price == null) continue;
    entries.push({
      name: item.name_th || item.name_en,
      names: [
        item.name_en.toLowerCase(),
        ...(item.name_th.length >= 4 ? [item.name_th.toLowerCase()] : []),
        ...(ITEM_ALIASES[item.code] ?? []),
      ],
      prices: [Number(item.price)],
      noPrice: false,
      note: null,
    });
  }
  for (const pkg of packages) {
    entries.push({ name: pkg.name, names: [pkg.name.toLowerCase()], prices: [Number(pkg.price)], noPrice: false, note: null });
  }
  return entries;
}

const ASCII_ONLY = /^[a-z0-9 .-]+$/;
const ASCII_CHAR = /[a-z0-9]/;

interface NameHit { end: number; length: number; entry: PriceEntry }

function findNames(lower: string, entries: PriceEntry[]): NameHit[] {
  const hits: NameHit[] = [];
  for (const entry of entries) {
    for (const name of new Set(entry.names)) {
      for (let at = lower.indexOf(name); at !== -1; at = lower.indexOf(name, at + 1)) {
        // คำอังกฤษต้องเป็นคำเต็ม "pep" จะได้ไม่ตรงกับ "pepsi"
        if (ASCII_ONLY.test(name) && (ASCII_CHAR.test(lower[at - 1] ?? "") || ASCII_CHAR.test(lower[at + name.length] ?? ""))) continue;
        hits.push({ end: at + name.length, length: name.length, entry });
      }
    }
  }
  return hits;
}

/** ตัวเลขไทยและจุลภาคทำให้ตำแหน่งชื่อกับราคาคลาดกัน จึงแปลงก่อนหา */
const normalize = (text: string) =>
  text.toLowerCase().replace(/[๐-๙]/g, (d) => String("๐๑๒๓๔๕๖๗๘๙".indexOf(d))).replace(/(\d),(?=\d{3}(?!\d))/g, "$1");

/** ราคาไม่มีหน่วยนับเฉพาะเมื่ออยู่ติดชื่อบริการ เช่น "ตรวจน้ำตาล 150" */
const BARE_NUMBER_GAP = 12;
/** หน่วยที่ไม่ใช่ราคา */
const NOT_PRICE_AFTER = /^\s*(เข็ม|คน|ท่าน|ครั้ง|ชุด|ซอง|ขวบ|ปี|เดือน|สัปดาห์|วัน|ค่า|โรค|สายพันธุ์|โมง|นาฬิกา|น\.|%|[ก-ฮ].[ก-ฮ]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/;

export interface PriceConflict { name: string; price: number; expected: number[] }

/**
 * ราคาในคำตอบที่ขัดกับราคาของบริการนั้น
 * การมีเลขอยู่ในข้อมูลยังไม่พอ "ตรวจน้ำตาล 150 บาท" เลข 150 มีอยู่ในบริการอื่น แต่ไม่ใช่ราคาของรายการนี้
 */
export function findPriceConflicts(answer: string, question: string, entries: PriceEntry[]): PriceConflict[] {
  const asked = findNames(normalize(question), entries).map((h) => h.entry);
  const conflicts = new Map<string, PriceConflict>();
  const add = (name: string, price: number, expected: number[]) => conflicts.set(`${name}:${price}`, { name, price, expected });

  for (const sentence of normalize(answer).split(/\n|ค่ะ|คะ|ครับ|(?<=[^\d])\.(?=\s|$)/)) {
    const hits = findNames(sentence, entries);
    for (const m of sentence.matchAll(/(?<![\d.:/-])(\d+)(?![\d:/-])(?:\.\d+)?(\s*(?:บาท|baht|฿))?/g)) {
      const value = Number(m[1]);
      const at = m.index;
      const hasUnit = !!m[2];
      if (!hasUnit && NOT_PRICE_AFTER.test(sentence.slice(at + m[0].length))) continue;
      const before = hits.filter((h) => h.end <= at);
      const lastEnd = Math.max(-1, ...before.map((h) => h.end));
      if (!hasUnit && (lastEnd < 0 || at - lastEnd > BARE_NUMBER_GAP || value < 30)) continue;
      // ชื่อที่ยาวกว่าชนะ "น้ำตาลสะสม" ไม่ใช่ "น้ำตาล" ชื่อเท่ากันรวมราคาของทุกรายการ เช่น "ชุดใหญ่"
      const near = before.filter((h) => h.end === lastEnd);
      const longest = Math.max(0, ...near.map((h) => h.length));
      const owners = near.filter((h) => h.length === longest).map((h) => h.entry);
      const pool = owners.length ? owners : asked;
      if (!pool.length) continue;
      const expected = [...new Set(pool.flatMap((e) => e.prices))];
      if (!expected.includes(value)) add(pool[0].name, value, expected);
    }
  }
  return [...conflicts.values()];
}

/** คำตอบที่มีราคาขัดกับข้อมูล: ส่งเองไม่ได้และเตือนเจ้าหน้าที่ */
export function applyPriceConflictGuard<T extends { text: string; confidence: number; note?: string }>(option: T, question: string, entries: PriceEntry[]): T {
  const conflicts = findPriceConflicts(option.text, question, entries);
  if (!conflicts.length) return option;
  const noPrice = conflicts.some((c) => !c.expected.length);
  const warning = conflicts
    .map((c) => (c.expected.length ? `${c.name} ${c.price} บาท ไม่ตรงกับราคาในระบบ ${c.expected.join("/")}` : `${c.name} ไม่มีราคาในระบบ ห้ามบอกตัวเลข`))
    .join(" · ");
  return {
    ...option,
    confidence: noPrice ? 0 : Math.min(option.confidence, 0.5),
    note: option.note ? `${option.note} · ${warning}` : warning,
  };
}

const ASKS_PRICE = /ราคา|เท่าไ[รห]|กี่บาท|ค่าใช้จ่าย|ค่ายา|ค่าบริการ|ค่าตรวจ|แพงไหม|price|how much|cost/i;

/** ลูกค้าถามราคาบริการที่ไม่มีราคา: คืนข้อความจากเว็บ เพื่อไม่ให้คำตอบขึ้นกับ AI */
export function noPriceAnswer(question: string, entries: PriceEntry[]): string | null {
  if (!ASKS_PRICE.test(question)) return null;
  const entry = findNames(normalize(question), entries).map((h) => h.entry).find((e) => e.noPrice && e.note);
  return entry?.note ?? null;
}
