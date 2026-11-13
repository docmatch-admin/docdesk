import { findPriceConflicts, type PriceEntry } from "./price-catalog";
import { buildNumberSources, findUnverifiedNumbers } from "./number-guard";
import type { SuggestionOption } from "./types";

/** ความคล้ายขั้นต่ำที่ใช้คำตอบติดดาวได้เลยโดยไม่เรียก LLM */
export const STARRED_MIN_SIMILARITY = 0.92;
export const STARRED_CONFIDENCE = 0.9;
/** มีข้อความก่อนหน้าในช่วงนี้ = กำลังคุยต่อเนื่อง คำถามสั้นอาจหมายถึงเรื่องก่อนหน้า เช่น "ราคาเท่าไหร่" */
const ONGOING_CHAT_MS = 30 * 60 * 1000;

const GRATITUDE = ["ขอบพระคุณ", "ขอบคุณ", "ขอบใจ", "thankyou", "thanks", "thank", "thx", "ty"];
const AFFIRM = ["รับทราบ", "ทราบแล้ว", "เข้าใจแล้ว", "โอเค", "okay", "ok", "ตกลง", "ได้เลย", "ได้"];
const FILLER = ["นะครับ", "นะคะ", "ครับผม", "ครับ", "ค่ะ", "คับ", "ค่า", "ค้า", "คร้าบ", "ฮะ", "จ้า", "จ้ะ", "มากๆ", "มาก", "นะ", "เลย", "ๆ", "you", "so", "much"];
const TOKENS = [...GRATITUDE, ...AFFIRM, ...FILLER, "คะ"].sort((a, b) => b.length - a.length);

/** thanks = ขอบคุณ, affirm = รับทราบ/ตอบรับ/อีโมจิ ซึ่งอาจเป็นคำตอบของคำถามที่คลินิกเพิ่งถาม */
export function classifyAck(line: string): "thanks" | "affirm" | null {
  if (/[?？]/.test(line)) return null;
  let rest = line.toLowerCase().replace(/[\p{P}\p{S}\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s]/gu, "")
    // ลากเสียง: ค่าา ขอบคุณค้าาา โอเคคค ครับบบ → ตัวเดียว (ซ้ำ 2 ตัวยุบเฉพาะสระ เพราะ "โอเคค่ะ" มี ค ติดกันอยู่แล้ว)
    .replace(/(.)\1{2,}/gu, "$1").replace(/([าะ])\1+/gu, "$1");
  if (!rest) return /\S/.test(line) ? "affirm" : null;
  const original = rest;
  const seen: string[] = [];
  while (rest) {
    const t = TOKENS.find((x) => rest.startsWith(x));
    if (!t) return null;
    seen.push(t);
    rest = rest.slice(t.length);
  }
  if (seen.some((t) => GRATITUDE.includes(t))) return "thanks";
  if (seen.some((t) => AFFIRM.includes(t))) return "affirm";
  // "ครับ" หรือ "ค่ะ" เดี่ยวๆ คือการตอบรับ ส่วน "คะ" เดี่ยวๆ คือการเรียกหรือถาม
  return original === "คะ" ? null : "affirm";
}

/** ข้อความที่ระบบแทนไฟล์แนบ ไม่ใช่คำพูดลูกค้า */
export const isAttachmentPlaceholder = (body: string) => /^\s*\[(ลูกค้าส่ง|รูปภาพ)/.test(body);

/** มีข้อความที่ลูกค้าพิมพ์จริง: รูปหรือไฟล์แนบที่ตามหลังมาต้องไม่ยกเลิกการร่างคำตอบของข้อความนั้น */
export const isCustomerText = (body: string) => !!body.trim() && !isAttachmentPlaceholder(body);

/** คำขอบคุณหรือสติกเกอร์ล้วน: ไม่ต้องเปิดแชทที่เสร็จแล้วกลับมา ข้อความอื่นรวมรูปต้องเปิดเสมอ */
export function isThanksOrSticker(text: string, isImage = false): boolean {
  if (isImage) return false;
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => /^\s*\[ลูกค้าส่ง\s*sticker/i.test(l) || classifyAck(l) === "thanks");
}

const asksQuestion =(text: string) => /[?？]|ไหม|มั้ย|หรือเปล่า|รึเปล่า|หรือไม่|คะ\s*$/.test(text);

const STICKER_LINE = /^\s*\[ลูกค้าส่ง\s*(sticker|สติกเกอร์)/i;
/** LINE แปลงอีโมติคอนเป็นคำในวงเล็บ เช่น (ชอบ) (love) */
const LINE_EMOTICON = /\([^()\n]{1,15}\)/g;
/** คำถามของลูกค้า: ไม่ใช้ "คะ" ท้ายประโยค เพราะลูกค้าพิมพ์ "นะคะ" ตอนบอกลาด้วย */
const CUSTOMER_QUESTION = /[?？]|ไหม|มั้ย|หรือเปล่า|รึเปล่า|หรือยัง|กี่|อะไร|ยังไง|อย่างไร|เท่าไหร่|เท่าไร|ที่ไหน|เมื่อไหร่|เมื่อไร|ทำไม/;
const GOODBYE = [
  // เดี๋ยวขอปรึกษาที่ทำงานก่อน, ไว้ขอคิดดูอีกที (ไม่รับ "ขอถามก่อน" "ขอดูรูปก่อน" ซึ่งแปลว่ากำลังจะถามต่อ)
  /(เดี๋ยว|เดียว|ไว้)\s*(ขอ\s*)?(ไป\s*)?(ปรึกษา|คิด|ถาม|ดู|เช็ค|เช็ก|ตัดสินใจ)[^\n]*(ก่อน|อีกที|อีกครั้ง)/,
  /ขอ\s*(ปรึกษา|คิด|ตัดสินใจ)[^\n]*(ก่อน|อีกที|อีกครั้ง)/,
  // ไว้จะติดต่อมาใหม่, แล้วจะแจ้งกลับ, เดี๋ยวทักมาอีกที
  /(ไว้|แล้ว|เดี๋ยว|เดียว)\s*(จะ\s*)?(ติดต่อ|ทัก|แจ้ง|โทร)\s*(มา|กลับ|ไป)?\s*(ใหม่|อีกที|อีกครั้ง|กลับ)/,
  /^\s*(บาย|bye|ลาก่อน|แค่นี้)/i,
];

/** ข้อความของเจ้าหน้าที่เป็นคำถามที่รอลูกค้าตอบ: "คะ" ท้ายประโยคนับ แต่ "นะคะ" ไม่นับ เช่น ขอบคุณนะคะ */
export const isStaffQuestion = (text: string) => CUSTOMER_QUESTION.test(text) || /ไหน/.test(text) || /(?<!นะ)คะ\s*$/.test(text.trim());

export type ClosingKind = "thanks" | "affirm" | "goodbye";

/**
 * ข้อความที่นับเป็นการคุยกับลูกค้า (ใช้ดูว่า "เราตอบล่าสุดหรือยัง")
 * ข้อความระบบไม่นับ (เช่น ตอบกลับอัตโนมัติของเพจ) ยกเว้นข้อความนัดที่ระบบนัดส่งถึงลูกค้า เช่น รับเรื่องขอเลื่อนนัดแล้ว
 */
export function isConversationTurn(m: { direction: string; sender_type: string; imported_sender_name?: string | null }): boolean {
  if (m.sender_type !== "system") return true;
  return m.direction === "out" && (m.imported_sender_name ?? "").startsWith("ระบบนัด");
}

/** ข้อความที่จบการคุยได้: ขอบคุณ, ตอบรับ/อีโมจิ/สติกเกอร์, หรือบอกลา ทุกบรรทัดต้องเป็นแบบนี้และไม่มีคำถาม */
export function classifyClosingMessage(text: string, isImage = false): ClosingKind | null {
  if (isImage) return null;
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return null;
  const kinds: ClosingKind[] = [];
  for (const line of lines) {
    if (STICKER_LINE.test(line)) { kinds.push("affirm"); continue; }
    const clean = line.replace(LINE_EMOTICON, " ");
    if (!clean.trim()) { kinds.push("affirm"); continue; }
    const ack = classifyAck(clean);
    if (ack) { kinds.push(ack); continue; }
    if (!CUSTOMER_QUESTION.test(clean) && GOODBYE.some((r) => r.test(clean))) { kinds.push("goodbye"); continue; }
    return null;
  }
  return kinds.includes("goodbye") ? "goodbye" : kinds.includes("thanks") ? "thanks" : "affirm";
}

/**
 * ลูกค้าจบการคุยหลังเราตอบแล้ว ไม่ต้องตอบต่อ
 * "โอเค" หรือสติกเกอร์หลังเราถาม เช่น สะดวกบ่ายสองไหมคะ คือคำตอบที่ต้องตอบต่อ
 */
export function endsConversation(kind: ClosingKind | null, lastMessage: { direction: string; text: string } | null): boolean {
  if (!kind || lastMessage?.direction !== "out") return false;
  // ใช้ isStaffQuestion ไม่ใช่ asksQuestion: "จะรีบแจ้งนะคะ" ลงท้าย นะคะ แต่ไม่ได้ถาม
  return kind !== "affirm" || !isStaffQuestion(lastMessage.text);
}

/** ไม่ต้องร่างคำตอบ: ทุกบรรทัดเป็นคำขอบคุณ/รับทราบ/อีโมจิ หรือไฟล์แนบที่ AI อ่านไม่ได้ */
export function shouldSkipSuggestion(pendingText: string, lastOutText: string | null): boolean {
  const lines = pendingText.split("\n").filter((l) => l.trim());
  if (!lines.length) return false;
  return lines.every((line) => {
    if (isAttachmentPlaceholder(line)) return true;
    const kind = classifyAck(line);
    if (kind === "thanks") return true;
    // "โอเคค่ะ" หลังคลินิกถามว่าสะดวกไหม คือคำตอบที่ต้องตอบต่อ
    return kind === "affirm" && !(lastOutText && asksQuestion(lastOutText));
  });
}

const URGENT = [
  "ปวด", "เจ็บ", "มีไข้", "เป็นไข้", "ผื่น", "บวม", "แพ้ยา", "ผลแล็บ", "ผลแลป", "ผลเลือด", "ผลตรวจ", "กินยา", "ทานยา", "ขนาดยา",
  "ฉุกเฉิน", "หายใจไม่", "เลือดออก", "หมดสติ", "ร้องเรียน", "ไม่พอใจ", "ผิดหวัง", "แย่มาก", "ขอคุยกับ", "ขอสายเจ้าหน้าที่",
];
const SENSITIVE = [...URGENT, "อาการ", "ไข้", "ไอ", "แพ้", "แผล", "ท้อง", "ตั้งครรภ์", "ยา", "เจ้าหน้าที่", "คุณหมอ", "แพทย์"];
const HARMLESS = /อยาก|พยาบาล|ยาก|ยาว|ขยาย|ไอดี|ไอจี|ไอโฟน|ไอศกรีม/g;

/** ใช้ติดป้าย "ต้องให้คนตอบ" เมื่อยังไม่ได้เรียก AI จึงเลือกเฉพาะคำที่ชัด กันป้ายเตือนมั่ว */
export const hasUrgentSignal = (text: string) => URGENT.some((w) => text.includes(w));

/** ใช้กันการตอบโดยไม่ผ่าน LLM ซึ่งเป็นตัวคัดกรองเรื่องการแพทย์ จึงกว้างกว่า พลาดแล้วแค่เรียก LLM ตามปกติ */
export const hasSensitiveSignal = (text: string) => {
  const s = text.replace(HARMLESS, "");
  return SENSITIVE.some((w) => s.includes(w));
};

/** คำตอบแชทควรสั้น ยาวกว่านี้ไม่ให้ AI ส่งเอง */
export const MAX_ANSWER_CHARS = 200;
const LONG_ANSWER_PENALTY = 0.15;
/**
 * ต้องต่ำกว่าเกณฑ์ส่งเอง (AUTO_SEND_MIN_CONFIDENCE = 0.75)
 * ถ้าลดอย่างเดียว คำตอบยาวที่มั่นใจ 0.9 ขึ้นไปจะยังเหลือ 0.75 และถูกส่งเอง
 */
export const LONG_ANSWER_MAX_CONFIDENCE = 0.74;

const normalizeText = (s: string) => s.replace(/\s+/g, " ").trim();

/** คำตอบยาวเกินกำหนด: ลดความมั่นใจ ยกเว้นคำตอบดาวที่เจ้าหน้าที่ตั้งใจเขียนไว้แล้ว */
export function applyLengthGuard<T extends { text: string; confidence: number; note?: string }>(option: T, starredAnswers: string[] = []): T {
  if ([...option.text].length <= MAX_ANSWER_CHARS) return option;
  if (starredAnswers.some((a) => normalizeText(a) === normalizeText(option.text))) return option;
  const warning = `คำตอบยาวเกิน ${MAX_ANSWER_CHARS} ตัวอักษร`;
  return {
    ...option,
    confidence: Math.max(0, Math.min(option.confidence - LONG_ANSWER_PENALTY, LONG_ANSWER_MAX_CONFIDENCE)),
    note: option.note ? `${option.note} · ${warning}` : warning,
  };
}

/** เงื่อนไขการรับบริการที่ตัวกันตัวเลขจับไม่ได้ เช่น PEP/PrEP ต้องนัดก่อน */
const SERVICE_CLAIMS = ["ไม่ต้องนัด", "ไม่ต้องจอง", "ไม่ต้องรอคิว", "ฉีดได้เลย"];
const UNVERIFIED_CLAIM_MAX_CONFIDENCE = 0.5;

/** อ้างเงื่อนไขที่ไม่มีในข้อมูลคลินิก: ไม่ให้ AI ส่งเอง และเตือนเจ้าหน้าที่ */
export function applyClaimGuard<T extends { text: string; confidence: number; note?: string }>(option: T, trustedTexts: string[]): T {
  const unverified = SERVICE_CLAIMS.filter((c) => option.text.includes(c) && !trustedTexts.some((t) => t.includes(c)));
  if (!unverified.length) return option;
  const warning = `ตรวจสอบเงื่อนไข "${unverified.join(", ")}" (ไม่พบในข้อมูลคลินิก)`;
  return {
    ...option,
    confidence: Math.min(option.confidence, UNVERIFIED_CLAIM_MAX_CONFIDENCE),
    note: option.note ? `${option.note} · ${warning}` : warning,
  };
}

/** บอกลูกค้าให้ติดต่อทางช่องทางเดียวกับที่คุยอยู่ ไม่นับ "ทางไลน์นี้" ซึ่งหมายถึงแชทนี้ */
const SAME_CHANNEL_PATTERNS: Record<string, RegExp> = {
  line: /(ทาง|ผ่าน|แอด|ติดต่อ)\s*(LINE|ไลน์)(?!\s*นี้)/i,
  facebook: /(ทาง|ผ่าน|ติดต่อ)\s*(Facebook|เฟซบุ๊ก|เฟสบุ๊ค|เฟส|Messenger|อินบ็อกซ์|inbox)(?!\s*นี้)/i,
  instagram: /(ทาง|ผ่าน|ติดต่อ)\s*(Instagram|ไอจี|IG)(?!\s*นี้)/i,
};

/** ลูกค้าคุยทางช่องทางนี้อยู่แล้ว ให้ไอดีหรือบอกให้ติดต่อทางเดิมไม่มีประโยชน์: ไม่ให้ AI ส่งเอง และเตือนเจ้าหน้าที่ */
export function applySameChannelGuard<T extends { text: string; confidence: number; note?: string }>(
  option: T, channel: { type: string; name: string } | null,
): T {
  if (!channel) return option;
  const lower = option.text.toLowerCase();
  const handles = channel.name.match(/@[\w.-]+/g) ?? [];
  const hit = handles.some((h) => lower.includes(h.toLowerCase())) || !!SAME_CHANNEL_PATTERNS[channel.type]?.test(option.text);
  if (!hit) return option;
  const warning = `บอกให้ติดต่อทาง ${channel.name} ซึ่งลูกค้าคุยอยู่แล้ว`;
  return {
    ...option,
    confidence: Math.min(option.confidence, UNVERIFIED_CLAIM_MAX_CONFIDENCE),
    note: option.note ? `${option.note} · ${warning}` : warning,
  };
}

interface StyleExample { answer: string; starred: boolean }

/** เรียงคำตอบเดิมให้ AI เห็นแบบที่ควรเลียนก่อน: สั้นและติดดาว, สั้น, ติดดาว, ที่เหลือ แล้วสั้นก่อนในแต่ละกลุ่ม */
export function sortByStyle<T extends StyleExample>(examples: T[]): T[] {
  const rank = (e: T) => ([...e.answer].length <= MAX_ANSWER_CHARS ? 0 : 2) + (e.starred ? 0 : 1);
  return [...examples].sort((a, b) => rank(a) - rank(b) || [...a.answer].length - [...b.answer].length);
}

const STYLE_EXAMPLE_MAX_CHARS = 120;
const STYLE_EXAMPLE_COUNT = 3;
const HAS_URL = /https?:\/\//i;

/**
 * few-shot สำนวนจากคำตอบที่ติดดาวเท่านั้น เพราะถูกส่งให้ AI ในทุกแชท ไม่ขึ้นกับคำถาม
 * คำตอบที่ไม่ได้ติดดาวอาจเป็นคำแนะนำเฉพาะคนหรือมีชื่อลูกค้า ห้ามนำไปใช้ข้ามแชท
 */
export function pickStyleExamples<T extends StyleExample>(examples: T[]): T[] {
  return sortByStyle(examples.filter((e) => e.starred && [...e.answer].length <= STYLE_EXAMPLE_MAX_CHARS && !HAS_URL.test(e.answer)))
    .slice(0, STYLE_EXAMPLE_COUNT);
}

interface StarredHit { id: string; question: string; answer: string; starred: boolean; similarity: number }
interface ChatMsg { direction: "in" | "out"; sender_type: string; body: string; body_th: string | null; created_at: string }

/**
 * ใช้คำตอบติดดาวแทน LLM ได้ก็ต่อเมื่อปลอดภัยเท่าการถาม LLM
 * ตัวเลขต้องยืนยันได้จากฐานข้อมูลหรือเจ้าหน้าที่ ไม่นับคำตอบตัวเอง ไม่อย่างนั้นราคาเก่าจะผ่านเสมอ
 */
export function pickStarredAnswer(input: {
  question: string;
  examples: StarredHit[];
  knowledge: { title: string; content: string }[];
  msgs: ChatMsg[];
  priceEntries?: PriceEntry[];
}): SuggestionOption | null {
  const hit = input.examples
    .filter((e) => e.starred && e.similarity >= STARRED_MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)[0];
  if (!hit) return null;
  if (hasSensitiveSignal(input.question) || hasSensitiveSignal(hit.question)) return null;

  let start = input.msgs.length;
  while (start > 0 && input.msgs[start - 1].direction === "in") start--;
  const before = input.msgs[start - 1];
  const first = input.msgs[start];
  if (before && first && Date.parse(first.created_at) - Date.parse(before.created_at) < ONGOING_CHAT_MS) return null;

  const sources = buildNumberSources({ knowledge: input.knowledge, examples: [], msgs: input.msgs });
  if (findUnverifiedNumbers(hit.answer, sources).length) return null;
  if (findPriceConflicts(hit.answer, input.question, input.priceEntries ?? []).length) return null;

  return { text: hit.answer, source: "example", ref_ids: [hit.id], confidence: STARRED_CONFIDENCE };
}
