import { after } from "next/server";
import OpenAI from "openai";
import { recordLlmUsage } from "./llm-usage";
import { supabaseAdmin } from "./supabase/admin";

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

/** เรียก LLM ให้ตอบเป็น JSON */
export async function chatJSON<T>(system: string, user: string, temperature = 0.3): Promise<T> {
  const res = await openai().chat.completions.create({
    model: CHAT_MODEL,
    temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  logUsage("chat", CHAT_MODEL, res.usage?.prompt_tokens ?? 0, res.usage?.completion_tokens ?? 0);
  const raw = res.choices[0]?.message?.content ?? "{}";
  return JSON.parse(raw) as T;
}
