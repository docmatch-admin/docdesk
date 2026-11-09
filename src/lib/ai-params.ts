/**
 * พารามิเตอร์ของ OpenAI Chat Completions ตามชนิดโมเดล (ไม่แตะ network ใช้ทดสอบได้)
 * โมเดล reasoning (gpt-5*, o1, o3, o4*) ไม่รับ temperature/top_p/penalty และใช้ max_completion_tokens
 * ซึ่งรวม token ที่ใช้คิดด้วย จึงต้องเผื่อมากกว่าคำตอบจริง
 */
export type AiTask = "translate" | "draft" | "tag" | "close" | "health";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export const isReasoningModel = (model: string) => /^(gpt-5|o1|o3|o4)/i.test(model.trim());

/** "minimal" มีเฉพาะ gpt-5 / gpt-5-mini / gpt-5-nano รุ่นแรก รุ่นอื่นใช้ "low" */
export const supportsMinimalEffort = (model: string) => /^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/i.test(model.trim());

/** งานเล็ก (แปล จัดแท็ก ปิดแชท) คิดน้อยที่สุด ร่างคำตอบคิดระดับต่ำ */
export function effortFor(task: AiTask, model: string): ReasoningEffort {
  if (task === "draft") return "low";
  return supportsMinimalEffort(model) ? "minimal" : "low";
}

/** เพดาน token ของคำตอบ (โมเดล reasoning ต้องเผื่อส่วนที่ใช้คิด) */
const OUTPUT_TOKENS: Record<AiTask, number> = { translate: 1200, draft: 2500, tag: 400, close: 400, health: 50 };
const REASONING_HEADROOM: Record<AiTask, number> = { translate: 2000, draft: 6000, tag: 1500, close: 1500, health: 500 };

export interface ChatParamsInput {
  model: string;
  task: AiTask;
  temperature?: number;
  /** บังคับ effort ใช้ตอนลองใหม่หลังโมเดลไม่รับ "minimal" */
  effort?: ReasoningEffort;
}

export function chatParams(input: ChatParamsInput): Record<string, unknown> {
  const { model, task } = input;
  if (isReasoningModel(model)) {
    return {
      model,
      max_completion_tokens: OUTPUT_TOKENS[task] + REASONING_HEADROOM[task],
      reasoning_effort: input.effort ?? effortFor(task, model),
    };
  }
  return {
    model,
    max_tokens: OUTPUT_TOKENS[task],
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  };
}

/** อ่านชื่อพารามิเตอร์ที่ OpenAI ไม่รับจาก error 400 */
export function unsupportedParam(e: unknown): { param: string; message: string } | null {
  const err = e as { status?: number; param?: string | null; code?: string | null; message?: string; error?: { param?: string; message?: string } };
  if (err?.status !== 400) return null;
  const message = err.error?.message ?? err.message ?? "";
  if (!/unsupported|not supported|does not support/i.test(message) && !/unsupported/i.test(err.code ?? "")) return null;
  const param = err.param ?? err.error?.param ?? message.match(/'([a-z_]+)'/i)?.[1] ?? "unknown";
  return { param, message };
}
