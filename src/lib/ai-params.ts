/**
 * พารามิเตอร์ของ OpenAI Chat Completions ตามชนิดโมเดล (ไม่แตะ network ใช้ทดสอบได้)
 * โมเดล reasoning (gpt-5*, o1, o3, o4*) ไม่รับ temperature/top_p/penalty และใช้ max_completion_tokens
 * ซึ่งรวม token ที่ใช้คิดด้วย จึงต้องเผื่อมากกว่าคำตอบจริง
 */
export type AiTask = "translate" | "draft" | "tag" | "close" | "health";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/** โมเดล reasoning: gpt-5 ขึ้นไป (gpt-5.1, gpt-6-luna, gpt-6.1-terra ...) และตระกูล o (o1, o3, o4-mini ...) */
export const isReasoningModel = (model: string) => /^(gpt-(?:[5-9]|[1-9]\d)(?!\d)|o\d)/i.test(model.trim());

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

const SAMPLING = ["temperature", "top_p", "presence_penalty", "frequency_penalty", "logit_bias"];

/**
 * ปรับพารามิเตอร์หลัง OpenAI ไม่รับตัวใดตัวหนึ่ง (คืน null = แก้ไม่ได้ ให้ throw)
 * - max_tokens → max_completion_tokens (เผื่อ token ส่วนที่ใช้คิด)
 * - temperature/top_p/penalty → ตัดทิ้ง (โมเดลรับเฉพาะค่าเริ่มต้น)
 * - reasoning_effort "minimal" → "low" แล้วถ้ายังไม่รับก็ตัดทิ้ง
 * - พารามิเตอร์อื่นที่ส่งไป → ตัดทิ้ง
 */
export function adjustForUnsupported(params: Record<string, unknown>, param: string, task: AiTask): Record<string, unknown> | null {
  const next = { ...params };
  if (param === "max_tokens" && "max_tokens" in next) {
    delete next.max_tokens;
    next.max_completion_tokens = OUTPUT_TOKENS[task] + REASONING_HEADROOM[task];
    return next;
  }
  if (SAMPLING.includes(param)) {
    for (const k of SAMPLING) delete next[k];
    return next;
  }
  if (param === "reasoning_effort" && "reasoning_effort" in next) {
    if (next.reasoning_effort !== "low") next.reasoning_effort = "low";
    else delete next.reasoning_effort;
    return next;
  }
  if (param in next && param !== "model") {
    delete next[param];
    return next;
  }
  return null;
}

/** error ของ OpenAI แบบสั้นสำหรับแสดงผู้ใช้/บันทึก: "OpenAI 400: ..." ไม่มีค่าลับ */
export function aiErrorSummary(e: unknown, max = 180): string {
  const err = e as { status?: number; message?: string; error?: { message?: string }; name?: string; code?: string };
  const status = typeof err?.status === "number" ? ` ${err.status}` : "";
  const msg = (err?.error?.message ?? err?.message ?? String(e)).replace(/^\d{3}\s+/, "").replace(/\s+/g, " ").trim();
  const kind = /timed? ?out|ETIMEDOUT|AbortError/i.test(`${err?.name} ${msg}`) ? " timeout" : "";
  return `OpenAI${status}${kind}: ${msg}`.slice(0, max);
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

/** คำตอบ JSON: ปกติเป็น JSON ล้วน บางโมเดลห่อด้วย ```json หรือมีข้อความนำ ดึงก้อน {...} แรกออกมา */
export function parseJsonReply<T>(raw: string): T {
  const text = (raw || "").trim();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)) as T; } catch { /* ด้านล่าง */ }
    }
    throw new Error(`AI ตอบไม่เป็น JSON: ${text.slice(0, 80)}`);
  }
}
