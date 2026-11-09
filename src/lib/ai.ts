import { after } from "next/server";
import OpenAI from "openai";
import { adjustForUnsupported, chatParams, parseJsonReply, unsupportedParam, type AiTask } from "./ai-params";
import { modelFor } from "./ai-models";
import { recordLlmUsage } from "./llm-usage";
import { supabaseAdmin } from "./supabase/admin";

export type { AiTask } from "./ai-params";

let client: OpenAI | null = null;
export function openai() {
  if (!client) client = new OpenAI();
  return client;
}

/** บันทึกค่าใช้จ่ายหลังส่งคำตอบแล้ว ผู้ใช้ไม่ต้องรอ นอก request เช่น สคริปต์หรือเทสต์ ส่งแบบไม่รอแทน */
function logUsage(kind: "chat" | "embedding", model: string, input: number, output: number) {
  const run = () => recordLlmUsage(supabaseAdmin(), kind, model, input, output);
  try {
    after(run);
  } catch {
    void run();
  }
}

/**
 * ชื่อโมเดลอ่านจากหน้าตั้งค่า (settings.ai_models) เป็นหลัก env เป็นค่าสำรองตอนฐานข้อมูลยังไม่มีค่า
 * ดู ai-models.ts
 */
export async function embed(text: string): Promise<number[]> {
  const EMBED_MODEL = await modelFor("embed");
  const res = await openai().embeddings.create({ model: EMBED_MODEL, input: text.slice(0, 8000) });
  logUsage("embedding", EMBED_MODEL, res.usage?.prompt_tokens ?? 0, 0);
  return res.data[0].embedding;
}

/** embedding ทีละชุด เร็วกว่าและถูกกว่าการเรียกทีละข้อความตอนนำเข้า */
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const EMBED_MODEL = await modelFor("embed");
  const res = await openai().embeddings.create({ model: EMBED_MODEL, input: texts.map((t) => t.slice(0, 8000)) });
  logUsage("embedding", EMBED_MODEL, res.usage?.prompt_tokens ?? 0, 0);
  return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export interface CallModelInput {
  task: AiTask;
  system: string;
  user: string;
  /** ใช้เฉพาะโมเดลที่ไม่ใช่ reasoning */
  temperature?: number;
  /** ใช้ทดสอบเทียบโมเดล ปกติใช้โมเดลของงานจากหน้าตั้งค่า */
  model?: string;
}

/**
 * เรียก LLM ทุกงานผ่านที่นี่ ให้ตอบเป็น JSON
 * โมเดล reasoning ไม่ส่ง temperature และใช้ reasoning_effort ตามงาน
 * ถ้า OpenAI ไม่รับพารามิเตอร์ใด log ชื่อพารามิเตอร์กับโมเดลให้ชัด แล้วปรับทีละตัวแล้วลองใหม่ (สูงสุด 4 ครั้ง)
 * และจำไว้ต่อโมเดล ครั้งต่อไปส่งพารามิเตอร์ที่รับได้ตั้งแต่แรก ไม่ต้องล้มก่อน
 */
const learned = new Map<string, string[]>();
const MAX_ATTEMPTS = 4;

export async function callModel<T>(input: CallModelInput): Promise<T> {
  // งานแปลใช้โมเดลแปล (ว่าง = โมเดลหลัก) งานอื่นใช้โมเดลหลัก
  const model = input.model ?? await modelFor(input.task === "translate" ? "translate" : "draft");
  let params = chatParams({ model, task: input.task, temperature: input.temperature });
  for (const p of learned.get(model) ?? []) params = adjustForUnsupported(params, p, input.task) ?? params;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await openai().chat.completions.create({
        ...params,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
      logUsage("chat", model, res.usage?.prompt_tokens ?? 0, res.usage?.completion_tokens ?? 0);
      const choice = res.choices[0];
      const raw = choice?.message?.content ?? "";
      // โมเดล reasoning ใช้ token หมดกับการคิดจนไม่มีคำตอบ
      if (!raw.trim() && choice?.finish_reason === "length") throw new Error(`AI ใช้ token หมดก่อนตอบ (finish_reason=length, model ${model})`);
      return parseJsonReply<T>(raw);
    } catch (e) {
      const bad = unsupportedParam(e);
      if (!bad) throw e;
      console.error(`OpenAI 400 unsupported parameter "${bad.param}" for model ${model} (task ${input.task}): ${bad.message}`);
      const next = adjustForUnsupported(params, bad.param, input.task);
      if (!next || attempt === MAX_ATTEMPTS - 1) throw e;
      params = next;
      learned.set(model, [...new Set([...(learned.get(model) ?? []), bad.param])]);
    }
  }
  throw new Error("unreachable");
}

/** ใช้กับโค้ดเดิม เทียบเท่า callModel งานร่างคำตอบ */
export async function chatJSON<T>(system: string, user: string, temperature = 0.3, task: AiTask = "draft"): Promise<T> {
  return callModel<T>({ task, system, user, temperature });
}
