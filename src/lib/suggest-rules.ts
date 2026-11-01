import { buildNumberSources, findUnverifiedNumbers } from "./number-guard";
import type { SuggestionOption } from "./types";

/** ความคล้ายขั้นต่ำที่ใช้คำตอบติดดาวได้เลยโดยไม่เรียก LLM */
export const STARRED_MIN_SIMILARITY = 0.92;
export const STARRED_CONFIDENCE = 0.9;
/** มีข้อความก่อนหน้าในช่วงนี้ = กำลังคุยต่อเนื่อง คำถามสั้นอาจหมายถึงเรื่องก่อนหน้า เช่น "ราคาเท่าไหร่" */
const ONGOING_CHAT_MS = 30 * 60 * 1000;

const GRATITUDE = ["ขอบพระคุณ", "ขอบคุณ", "ขอบใจ", "thankyou", "thanks", "thank", "thx", "ty"];
const AFFIRM = ["รับทราบ", "ทราบแล้ว", "เข้าใจแล้ว", "โอเค", "okay", "ok", "ตกลง", "ได้เลย", "ได้"];
const FILLER = ["นะครับ", "นะคะ", "ครับผม", "ครับ", "ค่ะ", "คับ", "ค่า", "จ้า", "จ้ะ", "มากๆ", "มาก", "นะ", "เลย", "ๆ", "you", "so", "much"];
const TOKENS = [...GRATITUDE, ...AFFIRM, ...FILLER, "คะ"].sort((a, b) => b.length - a.length);

/** thanks = ขอบคุณ, affirm = รับทราบ/ตอบรับ/อีโมจิ ซึ่งอาจเป็นคำตอบของคำถามที่คลินิกเพิ่งถาม */
export function classifyAck(line: string): "thanks" | "affirm" | null {
  if (/[?？]/.test(line)) return null;
  let rest = line.toLowerCase().replace(/[\p{P}\p{S}\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s]/gu, "");
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

const asksQuestion = (text: string) => /[?？]|ไหม|มั้ย|หรือเปล่า|รึเปล่า|หรือไม่|คะ\s*$/.test(text);

/** ไม่ต้องร่างคำตอบ: ทุกบรรทัดเป็นคำขอบคุณ/รับทราบ/อีโมจิ หรือไฟล์แนบที่ AI อ่านไม่ได้ */
export function shouldSkipSuggestion(pendingText: string, lastOutText: string | null): boolean {
  const lines = pendingText.split("\n").filter((l) => l.trim());
  if (!lines.length) return false;
  return lines.every((line) => {
    if (line.trim().startsWith("[ลูกค้าส่ง")) return true;
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

  return { text: hit.answer, source: "example", ref_ids: [hit.id], confidence: STARRED_CONFIDENCE };
}
