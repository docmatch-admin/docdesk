import type { SupabaseClient } from "@supabase/supabase-js";

/** ค่าประมาณ ปรับเมื่ออัตราแลกเปลี่ยนเปลี่ยนมาก */
export const USD_TO_THB = 33;

/** ราคาต่อ 1 ล้าน token (USD) ตามหน้าราคาของ OpenAI */
const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
};

export interface LlmUsageRow {
  day: string;
  kind: "chat" | "embedding";
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

export function bangkokDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** โมเดลที่ไม่รู้ราคาคิดเป็น 0 และรายงานชื่อไว้ เพื่อไม่ให้ตัวเลขดูครบทั้งที่ไม่ครบ */
export function estimateCostThb(rows: LlmUsageRow[]): number {
  const usd = rows.reduce((sum, r) => {
    const p = PRICES[r.model];
    return p ? sum + (r.input_tokens * p.input + r.output_tokens * p.output) / 1_000_000 : sum;
  }, 0);
  return usd * USD_TO_THB;
}

export function summarizeUsage(rows: LlmUsageRow[], today = bangkokDate()) {
  const month = rows.filter((r) => r.day.slice(0, 7) === today.slice(0, 7));
  const day = month.filter((r) => r.day === today);
  const llmCalls = (list: LlmUsageRow[]) => list.filter((r) => r.kind === "chat").reduce((n, r) => n + r.calls, 0);
  return {
    todayCalls: llmCalls(day),
    monthCalls: llmCalls(month),
    todayCostThb: estimateCostThb(day),
    monthCostThb: estimateCostThb(month),
    unpricedModels: [...new Set(month.map((r) => r.model).filter((m) => !PRICES[m]))],
  };
}

/** นับพลาดดีกว่าทำให้คำแนะนำหรือการส่งข้อความล้ม */
export async function recordLlmUsage(db: SupabaseClient, kind: "chat" | "embedding", model: string, input: number, output: number) {
  try {
    const { error } = await db.rpc("record_llm_usage", { p_kind: kind, p_model: model, p_input: input, p_output: output });
    if (error) throw error;
  } catch (e) {
    console.error("record llm usage failed", e);
  }
}
