import { scrubPII } from "./pii";

/** แยกข้อความที่ก๊อปจากห้องแชท ใช้ได้ทั้งหน้าเว็บและ server ไม่เก็บข้อความดิบ */
export type PasteSender = "customer" | "clinic" | "unknown" | "skip";
export interface PasteLine { text: string; sender: PasteSender }
export interface PastePair { question: string; answer: string }

const MIN_QUESTION_CHARS = 3;
const MIN_ANSWER_CHARS = 4;
export const MAX_PASTE_PAIRS = 200;

// บรรทัดที่ไม่ใช่ข้อความ เช่น เวลา สถานะอ่าน วันที่คั่น
const NOISE = [
  /^\d{1,2}[:.]\d{2}(\s*(น\.?|am|pm))?$/i,
  /^(อ่านแล้ว|read)(\s+\d+)?$/i,
  /^(วันนี้|เมื่อวาน|today|yesterday)$/i,
  /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/,
];

/** รูปแบบผู้ส่งยังต้องปรับตามตัวอย่างจริง บรรทัดที่ไม่รู้จึงเป็น unknown ไม่เดา */
export function parsePastedChat(content: string): PasteLine[] {
  return content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((text) => ({ text, sender: NOISE.some((n) => n.test(text)) ? "skip" : "unknown" }));
}

/** โครงสร้างบรรทัดโดยไม่มีเนื้อหา ส่งให้ผู้พัฒนาปรับตัวแยกได้โดยไม่เปิดเผยข้อความลูกค้า */
export function maskPastedShape(content: string): string {
  return content.split(/\r?\n/).map((line) => line
    .replace(/\p{Script=Thai}+/gu, "ก")
    .replace(/[A-Za-z]+/g, "a")
    .replace(/\d/g, "9")
    .replace(/[^ก a9:./,()\-\t]/g, "?")).join("\n");
}

/** ลูกค้าหลายบรรทัดติดกันเป็นคำถามเดียว คลินิกหลายบรรทัดติดกันเป็นคำตอบเดียว บรรทัด unknown ตัดคู่ ไม่เดาว่าเป็นของใคร */
export function buildPastePairs(lines: PasteLine[]): PastePair[] {
  const pairs: PastePair[] = [];
  let questions: string[] = [];
  let answers: string[] = [];
  const flush = () => {
    const question = scrubPII(questions.join("\n")).trim();
    const answer = scrubPII(answers.join("\n")).trim();
    if (question.length >= MIN_QUESTION_CHARS && answer.length >= MIN_ANSWER_CHARS) pairs.push({ question, answer });
    questions = [];
    answers = [];
  };
  for (const { text, sender } of lines) {
    if (sender === "skip") continue;
    if (sender === "unknown") {
      flush();
    } else if (sender === "customer") {
      if (answers.length) flush();
      questions.push(text);
    } else if (questions.length) {
      answers.push(text);
    }
  }
  flush();
  return pairs;
}
