/** คำนวณราคาแล็บ: ใช้ทั้ง server และหน้าเว็บ ชนิดข้อมูลในไฟล์นี้ไม่มีต้นทุน ยกเว้นส่วนใบเสนอราคาด้านล่าง */
export interface LabItem { code: string; name_en: string; name_th: string; price: number | null; category: string; active: boolean }
export interface LabPackage {
  code: string;
  name: string;
  price: number;
  includes: string[];
  compare_item_codes: string[];
  items_without_single_price: string[];
  active: boolean;
}

const baht = (n: number) => Math.round(n).toLocaleString("en-US");

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** ชื่อรายการในแพ็กเกจ → รายการเดี่ยวที่ตั้งราคาแล้ว เผื่อภายหลังเพิ่ม UA หรือ Potassium เข้าตาราง */
function pricedItemNamed(name: string, items: LabItem[]): LabItem | undefined {
  return items.find((i) => i.price != null && (sameName(i.code, name) || sameName(i.name_en, name)));
}

export interface PackageValue {
  code: string;
  name: string;
  price: number;
  /** ซื้อแยกอย่างน้อย ไม่รวมรายการที่ยังไม่มีราคาเดี่ยวและค่าตรวจร่างกาย */
  singlesAtLeast: number;
  /** ประหยัดอย่างน้อย ไม่ติดลบ */
  savingAtLeast: number;
  unpriced: string[];
  includes: string[];
}

export function packageValue(pkg: LabPackage, items: LabItem[]): PackageValue {
  const byCode = new Map(items.map((i) => [i.code, i]));
  let total = 0;
  for (const code of pkg.compare_item_codes) total += Number(byCode.get(code)?.price ?? 0);
  const unpriced: string[] = [];
  for (const name of pkg.items_without_single_price) {
    const item = pricedItemNamed(name, items);
    if (item) total += Number(item.price);
    else unpriced.push(name);
  }
  return {
    code: pkg.code,
    name: pkg.name,
    price: Number(pkg.price),
    singlesAtLeast: total,
    savingAtLeast: Math.max(0, total - Number(pkg.price)),
    unpriced,
    includes: pkg.includes,
  };
}

// ---------------------------------------------------------------------------
// จับชื่อรายการจากข้อความลูกค้า
// ---------------------------------------------------------------------------
export const ITEM_ALIASES: Record<string, string[]> = {
  HIV: ["hiv", "เอชไอวี"],
  LIPID: ["ไขมัน", "คอเลสเตอรอล", "cholesterol", "ldl", "hdl", "triglyceride"],
  FBS: ["น้ำตาลในเลือด", "fbs", "น้ำตาล"],
  HBA1C: ["น้ำตาลสะสม", "hba1c"],
  CR: ["creatinine", "ครีเอตินิน"],
  LFT: ["lft", "ค่าตับ"],
  ALT: ["sgpt"],
  AST: ["sgot"],
  ABO: ["หมู่เลือด"],
  RH: ["หมู่เลือด"],
  VDRL: ["ซิฟิลิส", "vdrl"],
  HBSAG: ["hbsag", "ไวรัสตับอักเสบบี"],
  URIC: ["กรดยูริก", "เก๊าท์"],
  T3: ["ไทรอยด์"],
  T4: ["ไทรอยด์"],
  TSH: ["ไทรอยด์"],
  CA: ["แคลเซียม"],
  MG: ["แมกนีเซียม"],
  PAP: ["แปปสเมียร์"],
};
const UNPRICED_ALIASES: Record<string, string[]> = {
  UA: ["ua", "ตรวจปัสสาวะ", "ปัสสาวะ"],
  ALP: ["alp"],
  Potassium: ["potassium", "โพแทสเซียม"],
  "Urine microalbumin": ["microalbumin", "ไมโครอัลบูมิน"],
  OF: ["osmotic fragility"],
  DCIP: ["dcip"],
};

const ASCII_WORD = /^[a-z0-9 .-]+$/;
const ASCII_CHAR = /[a-z0-9]/;

/** หาคำในข้อความแล้วลบออก คำยาวถูกจับก่อน "CA 19-9" จะได้ไม่กลายเป็น Calcium */
function takeWord(hay: string, word: string): { found: boolean; rest: string } {
  if (!ASCII_WORD.test(word)) return hay.includes(word) ? { found: true, rest: hay.split(word).join(" ") } : { found: false, rest: hay };
  for (let at = hay.indexOf(word); at !== -1; at = hay.indexOf(word, at + 1)) {
    if (!ASCII_CHAR.test(hay[at - 1] ?? "") && !ASCII_CHAR.test(hay[at + word.length] ?? "")) {
      return { found: true, rest: `${hay.slice(0, at)} ${hay.slice(at + word.length)}` };
    }
  }
  return { found: false, rest: hay };
}

export function findRequestedItems(text: string, items: LabItem[]): { codes: string[]; unpriced: string[] } {
  const terms: { word: string; code?: string; unpriced?: string }[] = [];
  for (const item of items) {
    if (!item.active) continue;
    // ไม่ใช้รหัสสั้นอย่าง CA หรือ MG เพราะตรงกับ "500 mg" ได้
    terms.push({ word: item.name_en.toLowerCase(), code: item.code });
    if (item.name_th.length >= 4) terms.push({ word: item.name_th.toLowerCase(), code: item.code });
    for (const alias of ITEM_ALIASES[item.code] ?? []) terms.push({ word: alias, code: item.code });
  }
  for (const [name, aliases] of Object.entries(UNPRICED_ALIASES)) {
    if (pricedItemNamed(name, items)) continue;
    for (const alias of aliases) terms.push({ word: alias, unpriced: name });
  }
  terms.sort((a, b) => b.word.length - a.word.length);

  // คำเดียวกันอาจหมายถึงหลายรายการ เช่น "ไทรอยด์" จึงตัดออกจากข้อความหลังตรวจครบทุกรายการที่ใช้คำนั้น
  const codes = new Set<string>();
  const unpriced = new Set<string>();
  let hay = text.toLowerCase();
  for (let i = 0; i < terms.length;) {
    const word = terms[i].word;
    const same = terms.filter((t) => t.word === word);
    const { found, rest } = takeWord(hay, word);
    if (found) {
      hay = rest;
      for (const t of same) {
        if (t.code) codes.add(t.code);
        if (t.unpriced) unpriced.add(t.unpriced);
      }
    }
    i += same.length;
  }
  return { codes: [...codes], unpriced: [...unpriced] };
}

const LAB_KEYWORDS = ["ตรวจสุขภาพ", "ตรวจเลือด", "เจาะเลือด", "แล็บ", "แลบ", "แลป", "ตรวจแล็บ", "ราคาตรวจ", "โปรแกรมตรวจ", "แพ็กเกจตรวจ", "แพคเกจ", "แพ็กเกจ", "ฝากครรภ์", "lab test", "blood test", "health check", "checkup", "check-up"];
export const LAB_TAG = "ตรวจสุขภาพ";

export function isLabQuestion(text: string, tags: string[], items: LabItem[]): boolean {
  const hay = text.toLowerCase();
  if (tags.includes(LAB_TAG) || LAB_KEYWORDS.some((k) => hay.includes(k))) return true;
  const found = findRequestedItems(text, items);
  return found.codes.length > 0 || found.unpriced.length > 0;
}

// ---------------------------------------------------------------------------
// เทียบซื้อแยกกับแพ็กเกจ
// ---------------------------------------------------------------------------
export interface SelectionComparison {
  items: { code: string; name: string; price: number }[];
  /** ซื้อแยกรวมรายการที่มีราคา */
  singlesTotal: number;
  /** รายการที่ยังไม่มีราคาเดี่ยว ทำให้ยอดซื้อแยกเป็น "อย่างน้อย" */
  unpriced: string[];
  /** แพ็กเกจที่ครอบคลุมครบทุกรายการ ถูกสุดก่อน */
  covering: PackageValue[];
  cheapest: PackageValue | null;
  recommendation: "singles" | "package" | "ask_price" | "none";
  saving: number;
}

function packageCovers(pkg: LabPackage, code: string, items: LabItem[]): boolean {
  if (pkg.compare_item_codes.includes(code)) return true;
  const item = items.find((i) => i.code === code);
  return !!item && pkg.includes.some((n) => sameName(n, item.name_en) || sameName(n, item.code));
}

/**
 * เทียบว่าแบบไหนถูกกว่าสำหรับลูกค้า ราคาเท่ากันแนะนำซื้อแยก เพราะแพ็กเกจอาจเป็นของกลุ่มลูกค้าอื่น
 * ถ้ามีรายการที่ไม่มีราคาเดี่ยวและแพ็กเกจแพงกว่ายอดขั้นต่ำ ยังสรุปไม่ได้ ต้องรอราคาจากคลินิก
 */
export function compareSelection(codes: string[], unpriced: string[], items: LabItem[], packages: LabPackage[]): SelectionComparison {
  const byCode = new Map(items.map((i) => [i.code, i]));
  const chosen = codes.map((c) => byCode.get(c)).filter((i): i is LabItem => !!i);
  const missingPrice = chosen.filter((i) => i.price == null).map((i) => i.name_en);
  const allUnpriced = [...unpriced, ...missingPrice];
  const priced = chosen.filter((i) => i.price != null);
  const singlesTotal = priced.reduce((sum, i) => sum + Number(i.price), 0);

  const covering = packages
    .filter((p) => p.active && (chosen.length + unpriced.length > 0))
    .filter((p) => chosen.every((i) => packageCovers(p, i.code, items)))
    .filter((p) => unpriced.every((name) => p.includes.some((n) => sameName(n, name))))
    .map((p) => packageValue(p, items))
    .sort((a, b) => a.price - b.price);
  const cheapest = covering[0] ?? null;

  let recommendation: SelectionComparison["recommendation"] = "singles";
  if (!chosen.length && !unpriced.length) recommendation = "none";
  else if (cheapest && cheapest.price < singlesTotal) recommendation = "package";
  else if (allUnpriced.length) recommendation = cheapest && cheapest.price <= singlesTotal ? "package" : "ask_price";

  return {
    items: priced.map((i) => ({ code: i.code, name: i.name_en, price: Number(i.price) })),
    singlesTotal,
    unpriced: allUnpriced,
    covering,
    cheapest,
    recommendation,
    saving: recommendation === "package" && cheapest ? Math.max(0, singlesTotal - cheapest.price) : 0,
  };
}

const packageLine = (v: PackageValue) => {
  const compare = v.savingAtLeast > 0
    ? `ซื้อแยกอย่างน้อย ${baht(v.singlesAtLeast)} บาท ประหยัดอย่างน้อย ${baht(v.savingAtLeast)} บาท`
    : `ราคาเท่ากับหรือสูงกว่าซื้อแยก (ซื้อแยก ${baht(v.singlesAtLeast)} บาท) ไม่ได้ส่วนลด`;
  const unpriced = v.unpriced.length ? `; รายการที่ยังไม่มีราคาเดี่ยว: ${v.unpriced.join(", ")}` : "";
  return `- ${v.name}: ${baht(v.price)} บาท; ${compare}${unpriced}; รวม: ${v.includes.join(", ")}`;
};

/**
 * ข้อมูลราคาสำหรับ AI: ตัวเลขทุกตัวคำนวณด้วยโค้ดแล้ว
 * รับเฉพาะชนิดที่ไม่มีต้นทุน และสร้างข้อความจากฟิลด์ที่ระบุเท่านั้น
 */
export function buildLabContext(question: string, items: LabItem[], packages: LabPackage[]): string {
  const activeItems = items.filter((i) => i.active);
  const activePackages = packages.filter((p) => p.active);
  const { codes, unpriced } = findRequestedItems(question, items);
  const lines = [
    "ราคาขายล่าสุดของคลินิก ตัวเลขซื้อแยกและส่วนที่ประหยัดระบบคำนวณแล้ว ใช้ตัวเลขนี้เท่านั้น ห้ามบวกเลขเอง",
    "ยอดซื้อแยกเป็นยอดขั้นต่ำ ไม่รวมรายการที่ยังไม่มีราคาเดี่ยวและค่าตรวจร่างกายโดยแพทย์",
    "",
    "แพ็กเกจ:",
    ...activePackages.map((p) => packageLine(packageValue(p, items))),
    "",
    `รายการเดี่ยว: ${activeItems.map((i) => `${i.name_en} (${i.name_th}) ${i.price == null ? "ยังไม่มีราคาเดี่ยว" : `${baht(Number(i.price))} บาท`}`).join(" | ")}`,
  ];
  if (codes.length || unpriced.length) {
    const c = compareSelection(codes, unpriced, items, packages);
    lines.push("", "รายการที่ลูกค้าถามถึงในข้อความนี้:");
    if (c.items.length) lines.push(`- ซื้อแยก: ${c.items.map((i) => `${i.name} ${baht(i.price)} บาท`).join(", ")} รวม ${baht(c.singlesTotal)} บาท`);
    if (c.unpriced.length) lines.push(`- ยังไม่มีราคาเดี่ยว: ${c.unpriced.join(", ")}`);
    if (c.cheapest) lines.push(`- แพ็กเกจที่ถูกที่สุดที่ครอบคลุม: ${c.cheapest.name} ${baht(c.cheapest.price)} บาท`);
    if (c.recommendation === "package" && c.cheapest) lines.push(`- ระบบเทียบแล้ว: ซื้อแพ็กเกจ ${c.cheapest.name} ถูกกว่าซื้อแยก ประหยัด ${baht(c.saving)} บาท`);
    if (c.recommendation === "singles") lines.push("- ระบบเทียบแล้ว: ซื้อแยกถูกกว่าหรือเท่ากับแพ็กเกจ");
    if (c.recommendation === "ask_price") lines.push("- ระบบเทียบแล้ว: ยังสรุปไม่ได้ว่าแบบไหนถูกกว่า เพราะบางรายการยังไม่มีราคาเดี่ยว ให้บอกลูกค้าว่าจะแจ้งราคาให้ทีหลัง");
  }
  return lines.join("\n");
}

/** กฎการใช้ราคาแล็บใน prompt */
export const LAB_RULES = `- ราคาแล็บ: ใช้ตัวเลขจาก "ราคาแล็บ" เท่านั้น ห้ามบวกหรือคำนวณเลขเอง ถ้าคำตอบเดิมมีราคาไม่ตรงให้ยึด "ราคาแล็บ"
- ลูกค้าบอกรายการที่อยากตรวจ: แนะนำแบบที่ถูกกว่าตามผลเทียบของระบบ
- รายการที่ยังไม่มีราคาเดี่ยว: ห้ามเดาราคา ให้บอกว่าจะแจ้งราคาให้ทีหลัง
- แพ็กเกจฝากครรภ์ ผู้สูงอายุ หญิง และชาย เป็นของลูกค้ากลุ่มนั้น ถ้าไม่รู้ว่าลูกค้าตรงกลุ่มให้ถามกลับก่อนเสนอ`;

// ---------------------------------------------------------------------------
// ข้อความสรุปราคาให้ลูกค้า
// ---------------------------------------------------------------------------
export function buildPriceMessage(c: SelectionComparison, selectedPackages: PackageValue[] = []): string {
  const parts: string[] = [];
  if (c.items.length === 1) parts.push(`${c.items[0].name} ${baht(c.items[0].price)} บาทค่ะ`);
  else if (c.items.length) parts.push(`${c.items.map((i) => `${i.name} ${baht(i.price)} บาท`).join(", ")} รวม ${baht(c.singlesTotal)} บาทค่ะ`);
  if (c.unpriced.length) parts.push(`ส่วน ${c.unpriced.join(", ")} ขอแจ้งราคาให้ทีหลังนะคะ`);
  if (c.recommendation === "package" && c.cheapest) {
    parts.push(`ถ้าใช้${c.cheapest.name} ${baht(c.cheapest.price)} บาท จะประหยัดกว่า ${baht(c.saving)} บาทค่ะ`);
  }
  for (const p of selectedPackages) {
    parts.push(p.savingAtLeast > 0
      ? `${p.name} ${baht(p.price)} บาทค่ะ ถ้าซื้อแยกอย่างน้อย ${baht(p.singlesAtLeast)} บาท ประหยัดอย่างน้อย ${baht(p.savingAtLeast)} บาท`
      : `${p.name} ${baht(p.price)} บาทค่ะ`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// ใบเสนอราคา B2B: ใช้ต้นทุน จึงเรียกจาก server ที่ตรวจสิทธิ์ admin แล้วเท่านั้น
// ---------------------------------------------------------------------------
export interface B2bRules { tiers: { minStaff: number; percent: number }[]; minProfitPerPerson: number }
export const DEFAULT_B2B_RULES: B2bRules = {
  tiers: [{ minStaff: 10, percent: 5 }, { minStaff: 30, percent: 10 }, { minStaff: 100, percent: 15 }],
  minProfitPerPerson: 150,
};

export function normalizeB2bRules(value: unknown): B2bRules {
  const v = (value ?? {}) as Partial<B2bRules>;
  const tiers = Array.isArray(v.tiers)
    ? v.tiers.filter((t) => Number.isFinite(t?.minStaff) && Number.isFinite(t?.percent) && t.minStaff > 0 && t.percent >= 0 && t.percent < 100)
        .sort((a, b) => a.minStaff - b.minStaff)
    : [];
  const min = v.minProfitPerPerson;
  return {
    tiers: tiers.length ? tiers : DEFAULT_B2B_RULES.tiers,
    minProfitPerPerson: typeof min === "number" && Number.isFinite(min) && min >= 0 ? min : DEFAULT_B2B_RULES.minProfitPerPerson,
  };
}

export interface B2bQuote {
  count: number;
  listPrice: number;
  tierPercent: number;
  appliedPercent: number;
  unitPrice: number;
  total: number;
  unitProfit: number;
  totalProfit: number;
  /** ส่วนลดตามขั้นถูกจำกัดเพราะกำไรต่อคนจะต่ำกว่าขั้นต่ำ */
  limitedByMinProfit: boolean;
  /** ราคาปกติมีกำไรต่ำกว่าขั้นต่ำอยู่แล้ว จึงไม่ลดเลย */
  belowMinAtList: boolean;
}

/** ปัดราคาขึ้นเป็นบาทเต็ม ปัดลงอาจทำให้กำไรต่ำกว่าขั้นต่ำ */
export function quoteB2b(pkg: { price: number; cost: number }, count: number, rules: B2bRules): B2bQuote {
  const listPrice = Number(pkg.price);
  const cost = Number(pkg.cost);
  const tierPercent = rules.tiers.filter((t) => count >= t.minStaff).at(-1)?.percent ?? 0;
  const floor = cost + rules.minProfitPerPerson;
  const discounted = Math.ceil(listPrice * (1 - tierPercent / 100));
  // ไม่ขึ้นราคาเกินราคาปกติ แม้กำไรปกติจะต่ำกว่าขั้นต่ำ
  const unitPrice = Math.min(listPrice, Math.max(discounted, floor));
  const unitProfit = unitPrice - cost;
  return {
    count,
    listPrice,
    tierPercent,
    appliedPercent: listPrice > 0 ? Math.round(((listPrice - unitPrice) / listPrice) * 1000) / 10 : 0,
    unitPrice,
    total: unitPrice * count,
    unitProfit,
    totalProfit: unitProfit * count,
    limitedByMinProfit: tierPercent > 0 && unitPrice > discounted,
    belowMinAtList: listPrice - cost < rules.minProfitPerPerson,
  };
}

/** ข้อความให้ลูกค้า ห้ามมีต้นทุนหรือกำไร */
export function buildQuoteMessage(packageName: string, q: B2bQuote): string {
  const discount = q.unitPrice < q.listPrice ? ` (ปกติ ${baht(q.listPrice)} บาท)` : "";
  return `เสนอราคา${packageName} สำหรับพนักงาน ${baht(q.count)} ท่าน ท่านละ ${baht(q.unitPrice)} บาท${discount} รวม ${baht(q.total)} บาทค่ะ`;
}
