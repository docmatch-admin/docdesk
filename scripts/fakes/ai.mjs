// แทน src/lib/ai.ts ในเทสต์: นับการเรียกโดยไม่แตะ OpenAI
export const calls = { chat: 0, embed: 0 };
export const replies = { next: { needs_human: false, options: [{ text: "ร่างจาก LLM", source: "knowledge", ref_ids: [], confidence: 0.8 }] } };
// งานปิดแชท (closing-ai): ดู prompt ที่ส่ง · หน่วงครั้งถัดไป · ตอบตามงาน [[/คำในระบบ/, คำตอบ]]
export const aiLog = { prompts: [], delayNext: 0, byPrompt: [] };
export function reset() { calls.chat = 0; calls.embed = 0; delete calls.lastPrompt; aiLog.prompts = []; aiLog.delayNext = 0; aiLog.byPrompt = []; }
export async function embed() { calls.embed++; return [0.1, 0.2]; }
export async function embedMany(texts) { calls.embed += texts.length; return texts.map(() => [0.1, 0.2]); }
export async function callModel({ system, user }) { return chatJSON(system, user); }
export async function chatJSON(system, user) {
  aiLog.prompts.push({ system, user });
  if (aiLog.delayNext) { const ms = aiLog.delayNext; aiLog.delayNext = 0; await new Promise((r) => setTimeout(r, ms)); }
  if (calls.failNext) { const e = calls.failNext; calls.failNext = null; throw e; }
  calls.chat++;
  calls.lastPrompt = `${system}\n${user}`;
  const hit = aiLog.byPrompt.find(([re]) => re.test(system));
  return structuredClone(hit ? hit[1] : replies.next);
}
export const openaiState = { fail: null };
export const openai = () => ({
  embeddings: { create: async () => { if (openaiState.fail) throw new Error(openaiState.fail); return { data: [{ embedding: [0] }] }; } },
});
