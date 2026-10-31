import { chatJSON, embed } from "./ai";
import { getSetting } from "./mode";
import { applyNumberGuard, buildNumberSources } from "./number-guard";
import { supabaseAdmin } from "./supabase/admin";
import type { SuggestionOption, SuggestionResult, SuggestionSource } from "./types";

const KNOWLEDGE_MIN_SIM = 0.3;
const EXAMPLE_MIN_SIM = 0.45;
/** ความมั่นใจขั้นต่ำที่ให้ AI ส่งเองได้ (โหมด auto / fallback) */
export const AUTO_SEND_MIN_CONFIDENCE = 0.75;
/** หมวดที่ส่งให้ AI เสมอ ไม่ขึ้นกับผล vector search (คำถามหลายเรื่องมักค้นเวลาทำการไม่เจอ) */
const ALWAYS_INCLUDED_CATEGORIES = ["นโยบายการตอบ", "ข้อมูลคลินิก"];

interface KnowledgeHit { id: string; category: string; title: string; content: string; updated_at: string; similarity: number }
interface ExampleHit { id: string; question: string; answer: string; starred: boolean; use_count: number; created_at: string; similarity: number }

interface MsgRow { id: string; direction: "in" | "out"; sender_type: string; body: string; body_th: string | null; created_at: string }

const thDate = (iso: string) =>
  new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit", timeZone: "Asia/Bangkok" });

/** ข้อความลูกค้าชุดล่าสุดที่ยังไม่ได้ตอบ (ภาษาไทย) */
export function pendingCustomerText(msgs: MsgRow[]): { text: string; lastId: string | null } {
  const pending: MsgRow[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].direction === "out") break;
    pending.unshift(msgs[i]);
  }
  const pick = pending.length ? pending : msgs.filter((m) => m.direction === "in").slice(-1);
  return {
    text: pick.map((m) => m.body_th || m.body).join("\n"),
    lastId: pick.at(-1)?.id ?? null,
  };
}

export async function generateSuggestions(conversationId: string): Promise<SuggestionResult> {
  const db = supabaseAdmin();

  const { data: rows } = await db
    .from("messages")
    .select("id, direction, sender_type, body, body_th, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(30);
  const msgs = ((rows ?? []) as MsgRow[]).reverse();
  const { text: question, lastId } = pendingCustomerText(msgs);
  if (!question.trim()) return { id: null, options: [], needs_human: false };

  // ---- ค้น 2 แหล่งด้วย vector search ----
  const qEmbedding = await embed(question);
  const vec = JSON.stringify(qEmbedding);
  const [{ data: kRaw }, { data: eRaw }, { data: policy }] = await Promise.all([
    db.rpc("match_knowledge", { query_embedding: vec, match_count: 6 }),
    db.rpc("match_examples", { query_embedding: vec, match_count: 5 }),
    db.from("knowledge_items").select("id, category, title, content, updated_at").eq("active", true).in("category", ALWAYS_INCLUDED_CATEGORIES),
  ]);
  const knowledge = ((kRaw ?? []) as KnowledgeHit[]).filter((k) => k.similarity >= KNOWLEDGE_MIN_SIM);
  for (const p of (policy ?? []) as KnowledgeHit[]) {
    if (!knowledge.some((k) => k.id === p.id)) knowledge.push({ ...p, similarity: 1 });
  }
  const examples = ((eRaw ?? []) as ExampleHit[]).filter((e) => e.similarity >= EXAMPLE_MIN_SIM);

  const profile = await getSetting<{ name: string; tone: string }>("clinic_profile", {
    name: "HappiWell Medical Clinic", tone: "สุภาพ เป็นกันเอง",
  });

  // ---- แหล่งที่ 3: ประวัติของลูกค้าคนนี้ ----
  const history = msgs
    .slice(-20)
    .map((m) => `[${thDate(m.created_at)}] ${m.direction === "in" ? "ลูกค้า" : m.sender_type === "ai" ? "AI" : "เจ้าหน้าที่"}: ${m.body_th || m.body}`)
    .join("\n");

  const kBlock = knowledge.length
    ? knowledge.map((k) => `- [K:${k.id}] (${k.category}) ${k.title}: ${k.content} (อัปเดต ${thDate(k.updated_at)})`).join("\n")
    : "(ไม่พบข้อมูลที่เกี่ยวข้อง)";
  const eBlock = examples.length
    ? examples.map((e) =>
        `- [E:${e.id}]${e.starred ? " ⭐คำตอบมาตรฐาน" : ""} ใช้แล้ว ${e.use_count} ครั้ง ตอบเมื่อ ${thDate(e.created_at)}\n  ถาม: ${e.question}\n  ตอบ: ${e.answer}`).join("\n")
    : "(ยังไม่มีคำตอบเดิมที่คล้ายกัน)";

  const system = `คุณคือผู้ช่วยร่างคำตอบแชทให้เจ้าหน้าที่ของ ${profile.name}
โทนการตอบ: ${profile.tone}

แหล่งข้อมูล เรียงตามความน่าเชื่อถือ:
1) ฐานข้อมูลคลินิก [K:...] = ข้อมูลล่าสุด ถูกต้องที่สุด
2) คำตอบเดิมของเจ้าหน้าที่ [E:...] = ใช้เป็นแบบอย่างสำนวน/วิธีตอบ แต่ราคา/เวลา/ข้อเท็จจริงอาจเก่า
3) ประวัติแชทของลูกค้าคนนี้ = ใช้ต่อบริบท (เช่น เคยถามเรื่องไหน นัดอะไรไว้)

กฎ:
- ห้ามแต่งราคา เวลา บริการ หรือข้อเท็จจริงที่ไม่มีในข้อมูล ถ้าไม่มีข้อมูลให้ร่างคำตอบที่บอกว่าจะให้เจ้าหน้าที่ตรวจสอบแล้วแจ้งกลับ (confidence ต่ำ)
- ถ้าคำตอบเดิม [E] ขัดกับฐานข้อมูล [K] ให้ใช้ข้อมูลจาก [K] และใส่ note อธิบายสั้นๆ
- คำถามเรื่องอาการ การวินิจฉัย ผลแล็บ การใช้ยา/ขนาดยา หรือเรื่องฉุกเฉิน: needs_human = true และร่างคำตอบที่แนะนำให้มาพบแพทย์/โทรหาคลินิก ห้ามวินิจฉัยหรือแนะนำยาเอง; ถ้ามีสัญญาณฉุกเฉินให้แนะนำโทร 1669
- ลูกค้าขอคุยกับคน/ไม่พอใจ/ร้องเรียน: needs_human = true
- ให้ 1–3 ตัวเลือกที่ต่างกันจริง (เช่น ตอบสั้น / ตอบละเอียด / ถามกลับเพื่อเก็บข้อมูลที่ขาด) เขียนเป็นภาษาไทยเสมอ (ระบบจะแปลให้ลูกค้าเอง)
- source: "knowledge" ถ้าอิงฐานข้อมูลเป็นหลัก, "example" ถ้าอิงคำตอบเดิม, "history" ถ้าอิงประวัติลูกค้า
- ref_ids: id ที่อ้างอิง (ไม่ต้องใส่ K: หรือ E:)
- confidence 0–1: มั่นใจแค่ไหนว่าส่งได้เลยโดยไม่ต้องแก้

ตอบเป็น JSON:
{"needs_human": boolean, "reason": "เหตุผลสั้นๆ ถ้า needs_human",
 "options": [{"text": "...", "source": "knowledge|example|history", "ref_ids": ["..."], "confidence": 0.0, "note": "ถ้ามี"}]}`;

  const user = `## ฐานข้อมูลคลินิก
${kBlock}

## คำตอบเดิมของเจ้าหน้าที่ที่คล้ายกัน
${eBlock}

## ประวัติแชทล่าสุดของลูกค้าคนนี้
${history}

## ข้อความลูกค้าที่ต้องตอบตอนนี้
${question}`;

  const out = await chatJSON<{ needs_human?: boolean; reason?: string; options?: Partial<SuggestionOption>[] }>(system, user, 0.4);

  const validSources: SuggestionSource[] = ["knowledge", "example", "history"];
  const knownIds = new Set([...knowledge.map((k) => k.id), ...examples.map((e) => e.id)]);
  const numberSources = buildNumberSources({ knowledge, examples, msgs });
  const options: SuggestionOption[] = (out.options ?? [])
    .filter((o) => typeof o.text === "string" && o.text.trim())
    .slice(0, 3)
    .map((o) => ({
      text: o.text!.trim(),
      source: validSources.includes(o.source as SuggestionSource) ? (o.source as SuggestionSource) : "knowledge",
      ref_ids: (o.ref_ids ?? []).map((r) => String(r).replace(/^[KE]:/, "")).filter((r) => knownIds.has(r)),
      confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0)),
      ...(o.note ? { note: String(o.note) } : {}),
    }))
    .map((o) => applyNumberGuard(o, numberSources));

  const needs_human = !!out.needs_human;
  const { data: saved } = await db
    .from("suggestions")
    .insert({ conversation_id: conversationId, trigger_message_id: lastId, options, needs_human })
    .select("id")
    .single();

  if (needs_human) {
    await db.from("conversations").update({ needs_human: true }).eq("id", conversationId);
  }

  return { id: saved?.id ?? null, options, needs_human, reason: out.reason };
}
