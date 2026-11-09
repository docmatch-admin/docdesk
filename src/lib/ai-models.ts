import { resolveModels, type AiModelSettings, type ModelUse, type ResolvedModel } from "./ai-models-rules";
import { supabaseAdmin } from "./supabase/admin";

const TTL_MS = 60_000;
let cache: { at: number; value: Record<ModelUse, ResolvedModel> } | null = null;

const env = () => ({
  OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_EMBED_MODEL: process.env.OPENAI_EMBED_MODEL,
});

export async function loadModelSettings(): Promise<AiModelSettings> {
  const { data } = await supabaseAdmin().from("settings").select("value").eq("key", "ai_models").maybeSingle();
  return (data?.value as AiModelSettings | null) ?? {};
}

/** โมเดลที่ใช้จริงต่องาน: ฐานข้อมูลก่อน env สำรอง (cache 1 นาที ไม่อ่านฐานข้อมูลทุกครั้งที่เรียก AI) */
export async function activeModels(force = false): Promise<Record<ModelUse, ResolvedModel>> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let db: AiModelSettings = {};
  try {
    db = await loadModelSettings();
  } catch (e) {
    // อ่านฐานข้อมูลไม่ได้: ใช้ค่าเดิมที่ cache ไว้ถ้ามี ไม่งั้น env
    console.error("load ai_models failed", e instanceof Error ? e.message : e);
    if (cache) return cache.value;
  }
  const value = resolveModels(db, env());
  cache = { at: Date.now(), value };
  return value;
}

export async function modelFor(use: ModelUse): Promise<string> {
  return (await activeModels())[use].model;
}

/** หลังบันทึกในหน้าตั้งค่า ใช้ค่าใหม่ทันทีใน instance นี้ (instance อื่นภายใน 1 นาที) */
export function clearModelCache() {
  cache = null;
}

export const modelEnvFallback = () => resolveModels({}, env());
