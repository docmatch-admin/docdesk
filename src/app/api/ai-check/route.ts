import { NextResponse } from "next/server";
import { callModel, CHAT_MODEL } from "@/lib/ai";
import { isReasoningModel } from "@/lib/ai-params";
import { requireAdmin } from "@/lib/auth";
import { fromThai, toThai } from "@/lib/translate";

export const runtime = "nodejs";
export const maxDuration = 60;

const BASELINE_MODEL = "gpt-4o-mini";
const SAMPLE_EN = "Hello, can I book a blood test tomorrow morning? Do I need to fast?";
const SAMPLE_TH = "ได้เลยค่ะ พรุ่งนี้ 8 โมงเช้า งดน้ำงดอาหาร 8 ชั่วโมงก่อนมานะคะ";

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; result?: T; error?: string }> {
  const t = performance.now();
  try {
    const result = await fn();
    return { ok: true, ms: Math.round(performance.now() - t), result };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t), error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
  }
}

/** แอดมินตรวจว่า AI ทำงานกับโมเดลปัจจุบัน และเทียบเวลาแปลกับโมเดลเดิม */
export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  const translateSystem = `Detect the language of the message (ISO 639-1) and translate it into natural Thai. Return JSON: {"language": "<code>", "th": "<Thai>"}`;
  const [toTh, toEn, draft, baseline] = await Promise.all([
    timed(() => toThai(SAMPLE_EN)),
    timed(() => fromThai(SAMPLE_TH, "en")),
    timed(() => callModel<{ text?: string }>({
      task: "draft", temperature: 0.4,
      system: `You are a Thai clinic admin. Reply to the customer in Thai, short and polite. Return JSON: {"text": "<reply>"}`,
      user: "ลูกค้า: ขอนัดเจาะเลือดพรุ่งนี้เช้าได้ไหมคะ ต้องงดอาหารไหม",
    })),
    timed(() => callModel<{ th?: string }>({ task: "translate", temperature: 0, system: translateSystem, user: SAMPLE_EN, model: BASELINE_MODEL })),
  ]);
  return NextResponse.json({
    model: CHAT_MODEL,
    reasoning: isReasoningModel(CHAT_MODEL),
    translate_en_to_th: toTh,
    translate_th_to_en: toEn,
    draft,
    baseline: { model: BASELINE_MODEL, translate_en_to_th: baseline },
  }, { headers: { "Cache-Control": "no-store" } });
}
