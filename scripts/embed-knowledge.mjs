// สร้าง embedding ให้ knowledge_items / reply_examples ที่ยังไม่มี
// ใช้: node --env-file=.env.local scripts/embed-knowledge.mjs
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key || !process.env.OPENAI_API_KEY) {
  console.error("ต้องตั้ง NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY (รันด้วย node --env-file=.env.local)");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });
const openai = new OpenAI();
// โมเดลเดียวกับแอป: หน้าตั้งค่า (settings.ai_models.embed) ก่อน env สำรอง
const { data: aiModels } = await db.from("settings").select("value").eq("key", "ai_models").maybeSingle();
const model = aiModels?.value?.embed?.trim() || process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
console.log(`embedding model: ${model}`);

async function run(table, toText) {
  const { data, error } = await db.from(table).select("*").is("embedding", null).limit(500);
  if (error) throw error;
  if (!data.length) return console.log(`${table}: ครบแล้ว`);
  const res = await openai.embeddings.create({ model, input: data.map(toText) });
  for (let i = 0; i < data.length; i++) {
    const { error: e } = await db.from(table)
      .update({ embedding: JSON.stringify(res.data[i].embedding) })
      .eq("id", data[i].id);
    if (e) throw e;
  }
  console.log(`${table}: สร้าง embedding ${data.length} รายการ`);
}

await run("knowledge_items", (r) => `${r.category} | ${r.title}\n${r.content}`);
await run("reply_examples", (r) => r.question);
