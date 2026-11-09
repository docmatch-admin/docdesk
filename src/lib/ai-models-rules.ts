/**
 * ชื่อโมเดล AI: หน้าตั้งค่า (settings.ai_models ในฐานข้อมูล) เป็นแหล่งหลักแหล่งเดียว
 * env ใช้เป็นค่าสำรองเฉพาะตอนฐานข้อมูลยังไม่มีค่าของช่องนั้น ไม่มีทั้งคู่ใช้ค่าเริ่มต้นในโค้ด
 * ใช้ได้ทั้ง server และหน้าเว็บ (ไม่มี I/O)
 */
export interface AiModelSettings {
  /** โมเดลหลักของงานแชท (ร่างคำตอบ/AI ตอบ จัดแท็ก ตรวจระบบ) */
  chat?: string | null;
  /** งานแปล (แชท + ใบนัด) ว่าง = ใช้โมเดลหลัก */
  translate?: string | null;
  /** embedding สำหรับค้นความรู้และตัวอย่างคำตอบ */
  embed?: string | null;
}

export type ModelSource = "db" | "env" | "default";
export type ModelUse = "draft" | "translate" | "embed";

export const MODEL_DEFAULTS = { chat: "gpt-4o-mini", embed: "text-embedding-3-small" } as const;

export const MODEL_USE_LABEL: Record<ModelUse, string> = {
  draft: "ร่างคำตอบ / AI ตอบลูกค้า / จัดแท็ก",
  translate: "แปลข้อความแชท + ใบนัด EN",
  embed: "Embedding (ค้นความรู้/ตัวอย่างคำตอบ)",
};

export const SOURCE_LABEL: Record<ModelSource, string> = { db: "หน้าตั้งค่า", env: "env (Vercel)", default: "ค่าเริ่มต้นในโค้ด" };

/** ชื่อโมเดลที่รับ: ตัวอักษร ตัวเลข . - _ : ยาวไม่เกิน 80 */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,79}$/;

export const cleanModel = (v: unknown): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t && MODEL_NAME.test(t) ? t : null;
};

export interface ModelEnv { OPENAI_CHAT_MODEL?: string; OPENAI_MODEL?: string; OPENAI_EMBED_MODEL?: string }

export interface ResolvedModel { model: string; source: ModelSource; /** งานแปลที่ไม่ได้ตั้งเฉพาะ ใช้โมเดลหลัก */ inherited?: boolean }

export function resolveModels(db: AiModelSettings | null | undefined, env: ModelEnv): Record<ModelUse, ResolvedModel> {
  const envChat = cleanModel(env.OPENAI_CHAT_MODEL) ?? cleanModel(env.OPENAI_MODEL);
  const chat: ResolvedModel = cleanModel(db?.chat) ? { model: cleanModel(db?.chat)!, source: "db" }
    : envChat ? { model: envChat, source: "env" } : { model: MODEL_DEFAULTS.chat, source: "default" };
  const translate: ResolvedModel = cleanModel(db?.translate) ? { model: cleanModel(db?.translate)!, source: "db" } : { ...chat, inherited: true };
  const envEmbed = cleanModel(env.OPENAI_EMBED_MODEL);
  const embed: ResolvedModel = cleanModel(db?.embed) ? { model: cleanModel(db?.embed)!, source: "db" }
    : envEmbed ? { model: envEmbed, source: "env" } : { model: MODEL_DEFAULTS.embed, source: "default" };
  return { draft: chat, translate, embed };
}
