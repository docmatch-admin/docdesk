// แทน src/lib/ai.ts ในเทสต์: นับการเรียกโดยไม่แตะ OpenAI
export const calls = { chat: 0, embed: 0 };
export const replies = { next: { needs_human: false, options: [{ text: "ร่างจาก LLM", source: "knowledge", ref_ids: [], confidence: 0.8 }] } };
export function reset() { calls.chat = 0; calls.embed = 0; delete calls.lastPrompt; }
export async function embed() { calls.embed++; return [0.1, 0.2]; }
export async function embedMany(texts) { calls.embed += texts.length; return texts.map(() => [0.1, 0.2]); }
export async function chatJSON(system, user) {
  calls.chat++;
  calls.lastPrompt = `${system}\n${user}`;
  return structuredClone(replies.next);
}
export const CHAT_MODEL = "gpt-4o-mini";
export const EMBED_MODEL = "text-embedding-3-small";
export const openaiState = { fail: null };
export const openai = () => ({
  embeddings: { create: async () => { if (openaiState.fail) throw new Error(openaiState.fail); return { data: [{ embedding: [0] }] }; } },
});
