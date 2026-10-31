import OpenAI from "openai";

let client: OpenAI | null = null;
export function openai() {
  if (!client) client = new OpenAI();
  return client;
}

export const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
export const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

export async function embed(text: string): Promise<number[]> {
  const res = await openai().embeddings.create({ model: EMBED_MODEL, input: text.slice(0, 8000) });
  return res.data[0].embedding;
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
  const raw = res.choices[0]?.message?.content ?? "{}";
  return JSON.parse(raw) as T;
}
