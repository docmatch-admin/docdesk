import { chatJSON } from "./ai";

const THAI = /[฀-๿]/g;
const LETTERS = /[\p{L}]/gu;

/** เดาเร็วๆ ว่าเป็นภาษาไทยไหม (ไม่ต้องเรียก AI) */
export function looksThai(text: string): boolean {
  const letters = text.match(LETTERS)?.length ?? 0;
  if (letters === 0) return true; // มีแต่อีโมจิ/ตัวเลข ถือว่าไม่ต้องแปล
  const thai = text.match(THAI)?.length ?? 0;
  return thai / letters >= 0.5;
}


/** ข้อความลูกค้า → ภาษาไทยสำหรับเจ้าหน้าที่ */
export async function toThai(text: string): Promise<{ language: string; th: string | null }> {
  if (looksThai(text)) return { language: "th", th: null };
  const out = await chatJSON<{ language: string; th: string }>(
    `You are a translator for a Thai medical clinic's chat inbox.
Detect the language of the customer's message (ISO 639-1 code) and translate it into natural Thai.
Keep medicine names, numbers, dates and prices exact. Do not add anything.
Return JSON: {"language": "<code>", "th": "<Thai translation>"}`,
    text,
    0,
  );
  const language = (out.language || "en").toLowerCase().slice(0, 5);
  if (language === "th") return { language: "th", th: null };
  return { language, th: out.th || null };
}

/** ข้อความเจ้าหน้าที่ (ไทย) → ภาษาลูกค้า */
export async function fromThai(textTh: string, language: string): Promise<string> {
  if (!language || language === "th") return textTh;
  const out = await chatJSON<{ text: string }>(
    `You translate chat replies from a Thai medical clinic's staff to the customer.
Translate the Thai text into the language with ISO 639-1 code "${language}".
Write it the way a friendly clinic admin types in a chat app: short, casual and polite, not formal or corporate. Do not make it longer than the Thai, and do not add greetings, thanks or sign-offs that are not in the Thai.
Keep every fact and every instruction, especially medical or emergency advice. Keep prices, phone numbers, times, LINE IDs, URLs and emoji exactly.
Drop Thai politeness particles (ค่ะ/ครับ) naturally. Return JSON: {"text": "<translation>"}`,
    textTh,
    0,
  );
  return out.text || textTh;
}
