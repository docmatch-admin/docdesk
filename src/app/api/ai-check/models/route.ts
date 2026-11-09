import { NextResponse } from "next/server";
import type OpenAI from "openai";
import { callModel, openai } from "@/lib/ai";
import { aiErrorSummary, isReasoningModel } from "@/lib/ai-params";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

const SAMPLE = "งดน้ำงดอาหาร 8–12 ชม. (ดื่มน้ำเปล่าได้)";
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,79}$/;

async function timed<T>(fn: () => Promise<T>) {
  const t = performance.now();
  try {
    return { ok: true as const, ms: Math.round(performance.now() - t), value: await fn() };
  } catch (e) {
    const err = e as { status?: number };
    return { ok: false as const, ms: Math.round(performance.now() - t), status: err?.status ?? null, error: aiErrorSummary(e, 400) };
  }
}

/**
 * แอดมินตรวจโมเดลด้วย key ของระบบ (ไม่แสดง key): ?models=a,b,c
 * - models: ชื่อรุ่นที่ขึ้นต้น gpt-6 ที่ key นี้เรียกได้ (GET /v1/models)
 * - raw: เรียก /v1/chat/completions ตรงๆ แบบน้อยที่สุด (model + messages เท่านั้น) แปลประโยคตัวอย่าง
 * - helper: เรียกผ่าน callModel ของระบบ (พารามิเตอร์ตามงานแปลจริง)
 */
export async function GET(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const asked = (new URL(req.url).searchParams.get("models") ?? "").split(",").map((m) => m.trim()).filter((m) => MODEL.test(m)).slice(0, 6);

  const list = await timed(async () => {
    const ids: string[] = [];
    for await (const m of openai().models.list()) ids.push(m.id);
    return ids;
  });
  const gpt6 = list.ok ? list.value.filter((id) => /^gpt-6/i.test(id)).sort() : [];

  const results = [];
  for (const model of asked) {
    const raw = await timed(() => openai().chat.completions.create({
      model,
      messages: [{ role: "user", content: `Translate to short, clear English for a patient. Reply with the translation only.\n${SAMPLE}` }],
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming));
    const helper = await timed(() => callModel<{ text?: string }>({
      task: "translate", temperature: 0, model,
      system: "Translate the Thai text into short, clear English for a patient. Keep every number exactly. Return JSON: {\"text\": \"<English>\"}",
      user: SAMPLE,
    }));
    results.push({
      model,
      reasoning: isReasoningModel(model),
      listed: list.ok ? list.value.includes(model) : null,
      raw: raw.ok
        ? { ok: true, status: 200, ms: raw.ms, text: raw.value.choices[0]?.message?.content ?? "", finish: raw.value.choices[0]?.finish_reason ?? null, usage: raw.value.usage ?? null }
        : { ok: false, status: raw.status, ms: raw.ms, error: raw.error },
      helper: helper.ok ? { ok: true, ms: helper.ms, text: helper.value.text ?? "" } : { ok: false, status: helper.status, ms: helper.ms, error: helper.error },
    });
  }
  return NextResponse.json({
    models_ok: list.ok, models_error: list.ok ? null : list.error, gpt6,
    results,
  }, { headers: { "Cache-Control": "no-store" } });
}
