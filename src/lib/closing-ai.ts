// ปิดแชทอัตโนมัติ ชั้นที่สอง: ข้อความสั้น ๆ ที่คำตายตัว (classifyClosingMessage) จับไม่ได้ ให้ AI ช่วยตัดสินว่าลูกค้าจบการคุยหรือยัง
// ส่งเข้า AI แค่ 2 ข้อความ (เจ้าหน้าที่ล่าสุด + ลูกค้า) และปิดเฉพาะเมื่อมั่นใจ ≥ 0.8 · ล้ม/ช้า/ไม่แน่ใจ = ไม่ปิด (อยู่รอตอบเหมือนเดิม)
import { callModel } from "./ai";
import { CUSTOMER_QUESTION } from "./suggest-rules";

export const AI_CLOSE_MODEL = "gpt-4o-mini";
export const AI_CLOSE_MAX_CHARS = 30;
export const AI_CLOSE_MIN_CONFIDENCE = 0.8;
export const AI_CLOSE_TIMEOUT_MS = 2_000;
/** ข้อความเจ้าหน้าที่ที่ส่งให้ AI ดู ตัดให้สั้น (พอให้รู้บริบท) */
const STAFF_MAX_CHARS = 300;

export const AI_CLOSE_SYSTEM = `คุณช่วยคลินิกตัดสินว่า "ลูกค้าจบการคุยแล้วหรือยัง" จากข้อความล่าสุดของเจ้าหน้าที่ และข้อความที่ลูกค้าตอบกลับ
จบแล้ว = ลูกค้าแค่รับทราบ ตอบรับ ขอบคุณ หรือบอกลา และไม่ได้ถาม ขอ หรือรอให้เจ้าหน้าที่ทำอะไรต่อ
ยังไม่จบ = ลูกค้าถาม ขอข้อมูล ตอบคำถามที่เจ้าหน้าที่ถาม (เช่น เลือกวันเวลา ยืนยันนัด) แจ้งอาการ หรือข้อความกำกวม
ตอบ JSON เท่านั้น: {"ends": true|false, "confidence": 0-1}`;

/**
 * ข้อความลูกค้าที่ควรถาม AI: สั้น (≤ 30 ตัวอักษร) ไม่มีรูป/ไฟล์ ไม่มีคำถาม
 * และข้อความก่อนหน้าเป็นของเจ้าหน้าที่ (คน/AI ที่ตอบในแชท — ไม่ใช่ข้อความระบบ เช่น ข้อความนัด/ผลแล็บ)
 */
export function aiCloseCandidate(
  text: string,
  opts: { isImage?: boolean; hasFile?: boolean; last?: { direction: string; sender_type: string } | null },
): boolean {
  const t = text.trim();
  if (!t || opts.isImage || opts.hasFile) return false;
  if ([...t].length > AI_CLOSE_MAX_CHARS) return false;
  if (CUSTOMER_QUESTION.test(t)) return false;
  const last = opts.last;
  return !!last && last.direction === "out" && (last.sender_type === "staff" || last.sender_type === "ai");
}

/** ไม่ส่งข้อมูลคนไข้เข้า AI: ตัดชื่อลูกค้า/ชื่อคนไข้ เลข HN / เบอร์ / เลขยาว ๆ ออกจากข้อความเจ้าหน้าที่ */
export function maskStaffText(text: string, names: (string | null | undefined)[] = []): string {
  let out = text;
  for (const n of names) {
    const name = n?.trim();
    if (name && name.length >= 2) out = out.split(name).join("[ชื่อ]");
  }
  out = out.replace(/\bHN\s*[:：]?\s*\S+/gi, "HN [เลข]").replace(/\d[\d\s-]{3,}\d/g, "[เลข]");
  return [...out].slice(0, STAFF_MAX_CHARS).join("");
}

export interface AiCloseVerdict { ends: boolean; confidence: number }

/** null = ล้ม / เกินเวลา / ตอบไม่เป็นรูปแบบ → ไม่ปิด */
export async function aiJudgeClosing(staffText: string, customerText: string, timeoutMs = AI_CLOSE_TIMEOUT_MS): Promise<AiCloseVerdict | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = callModel<{ ends?: unknown; confidence?: unknown }>({
      task: "close",
      model: AI_CLOSE_MODEL,
      temperature: 0,
      system: AI_CLOSE_SYSTEM,
      user: `เจ้าหน้าที่: ${staffText}\nลูกค้า: ${customerText.trim()}`,
    });
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const r = await Promise.race([call, timeout]);
    call.catch(() => {}); // เกินเวลาแล้วล้มทีหลัง: ไม่ต้องสนใจ
    if (!r || typeof r.ends !== "boolean") return null;
    const confidence = Number(r.confidence);
    if (!Number.isFinite(confidence)) return null;
    return { ends: r.ends, confidence: Math.min(1, Math.max(0, confidence)) };
  } catch (e) {
    console.error("ai close judge failed", e instanceof Error ? e.message : e);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const aiSaysEnds = (v: AiCloseVerdict | null) => !!v && v.ends && v.confidence >= AI_CLOSE_MIN_CONFIDENCE;
