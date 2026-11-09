import { after } from "next/server";
import OpenAI from "openai";
import { chatParams, unsupportedParam, type AiTask } from "./ai-params";
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

/** ชื่อโมเดลอ่านจาก env ที่เดียว ทุกงานใช้ค่านี้ */
export const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
export const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

export async function embed(text: string): Promise<number[]> {
  const res = await openai().embeddings.create({ model: EMBED_MODEL, input: text.slice(0, 8000) });
  logUsage("embedding", EMBED_MODEL, res.usage?.prompt_tokens ?? 0, 0);
  return res.data[0].embedding;
}

/** embedding ทีละชุด เร็วกว่าและถูกกว่าการเรียกทีละข้อความตอนนำเข้า */
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
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
  /** ใช้ทดสอบเทียบโมเดล ปกติใช้ CHAT_MODEL */
  model?: string;
}

/**
 * เรียก LLM ทุกงานผ่านที่นี่ ให้ตอบเป็น JSON
 * โมเดล reasoning ไม่ส่ง temperature และใช้ reasoning_effort ตามงาน
 * ถ้า OpenAI ไม่รับพารามิเตอร์ใด log ชื่อพารามิเตอร์กับโมเดลให้ชัด แล้วลองใหม่หนึ่งครั้งโดยตัดพารามิเตอร์นั้น
 */
export async function callModel<T>(input: CallModelInput): Promise<T> {
  const model = input.model ?? CHAT_MODEL;
  let params = chatParams({ model, task: input.task, temperature: input.temperature });
  for (let attempt = 0; attempt < 2; attempt++) {
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
      const raw = res.choices[0]?.message?.content ?? "{}";
      return JSON.parse(raw || "{}") as T;
    } catch (e) {
      const bad = unsupportedParam(e);
      if (!bad) throw e;
      console.error(`OpenAI 400 unsupported parameter "${bad.param}" for model ${model} (task ${input.task}): ${bad.message}`);
      if (attempt > 0) throw e;
      // ลองใหม่: effort "minimal" ไม่รองรับ → "low", พารามิเตอร์อื่นตัดทิ้ง
      if (bad.param === "reasoning_effort" && params.reasoning_effort !== "low") {
        params = chatParams({ model, task: input.task, effort: "low" });
      } else if (bad.param in params) {
        const rest = { ...params };
        delete rest[bad.param];
        params = rest;
      } else {
        throw e;
      }
    }
  }
  throw new Error("unreachable");
}

/** ใช้กับโค้ดเดิม เทียบเท่า callModel งานร่างคำตอบ */
export async function chatJSON<T>(system: string, user: string, temperature = 0.3, task: AiTask = "draft"): Promise<T> {
  return callModel<T>({ task, system, user, temperature });
}
