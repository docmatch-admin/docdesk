import type { SuggestionOption } from "./types";

/** ใช้ได้ทั้ง server และหน้าเว็บ */
export const SENSITIVE_TAG = "STD";
export const SENSITIVE_TAG_LABEL = "🔒 ลับ";
export const SENSITIVE_NOTIFY_TEXT = "มีแชทลับใหม่";
export const SENSITIVE_ACK_TEXT = "ได้รับข้อความแล้วค่ะ เจ้าหน้าที่จะตอบกลับโดยเร็วที่สุดนะคะ";
export const DEFAULT_SENSITIVE_RETENTION_DAYS = 30;

export const DEFAULT_SENSITIVE_KEYWORDS = [
  "STD", "ซิฟิลิส", "หนองใน", "เริม", "หูดหงอนไก่", "HIV", "เอชไอวี", "PEP", "PrEP", "เพร็พ", "เป๊ป",
  "ตรวจโรคติดต่อทางเพศ", "โรคทางเพศ", "ตกขาว", "เสี่ยงมา", "ถุงยางแตก", "ถุงยางหลุด", "มีเพศสัมพันธ์", "มีอะไรกับ",
  "หนองไหล", "แผลที่อวัยวะเพศ", "คันอวัยวะเพศ", "VDRL", "TPHA", "CD4",
];

export const SENSITIVE_PROMPT_RULES = `- แชทนี้เป็นข้อมูลลับเรื่องเพศ: ตอบสุภาพ ไม่ตัดสิน ห้ามเขียนชื่อโรค ผลตรวจ หรือชื่อยาในคำตอบ ให้ใช้คำกลางๆ เช่น "ผลตรวจพร้อมแล้วค่ะ รบกวนมารับที่คลินิกหรือโทร 02-000-4586"`;

export function normalizeSensitiveKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_SENSITIVE_KEYWORDS;
  const words = [...new Set(value.filter((k): k is string => typeof k === "string").map((k) => k.trim()).filter(Boolean))];
  return words.length ? words : DEFAULT_SENSITIVE_KEYWORDS;
}

const ASCII_WORD = /^[a-z0-9 ]+$/;
const ASCII_CHAR = /[a-z0-9]/;

/** คำอังกฤษต้องเป็นคำเต็ม "pep" จะได้ไม่ตรงกับ "pepsi" */
export function matchSensitive(text: string, keywords: string[]): boolean {
  const hay = text.toLowerCase();
  return keywords.some((raw) => {
    const word = raw.trim().toLowerCase();
    if (!word) return false;
    if (!ASCII_WORD.test(word)) return hay.includes(word);
    for (let at = hay.indexOf(word); at !== -1; at = hay.indexOf(word, at + 1)) {
      if (!ASCII_CHAR.test(hay[at - 1] ?? "") && !ASCII_CHAR.test(hay[at + word.length] ?? "")) return true;
    }
    return false;
  });
}

/** คำแนะนำในแชทลับที่มีคำต้องห้าม ส่งเองไม่ได้ และเตือนเจ้าหน้าที่ */
export function applySensitiveGuard(option: SuggestionOption, keywords: string[]): SuggestionOption {
  if (!matchSensitive(option.text, keywords)) return option;
  return { ...option, confidence: 0, note: "มีคำเฉพาะเรื่องลับ โปรดแก้เป็นคำกลางๆ ก่อนส่ง" };
}

export const tagLabel = (name: string) => (name === SENSITIVE_TAG ? SENSITIVE_TAG_LABEL : name);
