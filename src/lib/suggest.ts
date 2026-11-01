import { chatJSON, embed } from "./ai";
import { bangkokDate } from "./llm-usage";
import { DEFAULT_CLINIC_PROFILE, getSetting, resolveAiMode } from "./mode";
import { applyNumberGuard, buildNumberSources } from "./number-guard";
import { applyClaimGuard, applyLengthGuard, pickStarredAnswer, pickStyleExamples, shouldSkipSuggestion, sortByStyle } from "./suggest-rules";
import { supabaseAdmin } from "./supabase/admin";
import { sanitizeSuggestedTags } from "./tags";
import type { AiMode, ChannelType, SuggestionOption, SuggestionResult, SuggestionSource } from "./types";
import { WEBCHAT_LIMITS } from "./webchat-guard";

const KNOWLEDGE_MIN_SIM = 0.3;
const EXAMPLE_MIN_SIM = 0.45;
/** ความมั่นใจขั้นต่ำที่ให้ AI ส่งเองได้ (โหมด auto / fallback) */
export const AUTO_SEND_MIN_CONFIDENCE = 0.75;
/** หมวดที่ส่งให้ AI เสมอ ไม่ขึ้นกับผล vector search (คำถามหลายเรื่องมักค้นเวลาทำการไม่เจอ) */
const ALWAYS_INCLUDED_CATEGORIES = ["นโยบายการตอบ", "ข้อมูลคลินิก"];
/** few-shot สไตล์แอดมินไลน์ */
const STYLE_FEW_SHOT = [
  "ไข้หวัดใหญ่เข็มละ 390 บาทค่ะ 😊",
  "เสาร์-อาทิตย์เปิด 08.00–12.00 น. ค่ะ",
  "ตรวจสุขภาพมีชุดเล็กกับชุดใหญ่ค่ะ สนใจแบบไหนดีคะ",
];

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
    text: pick.map((m) => m.body_th || m.body).filter((t) => t.trim()).join("\n"),
    lastId: pick.at(-1)?.id ?? null,
  };
}

/** โหมด auto/fallback ระบบร่างเองหลังรอ 8 วินาที เผื่อเวลาร่างไว้ด้วย กันเจ้าหน้าที่เปิดแชทแล้วเรียก LLM ซ้ำ */
const SERVER_DRAFT_WINDOW_MS = 20_000;

/**
 * เจ้าหน้าที่เปิดแชท: สร้างคำแนะนำถ้ายังไม่มีของข้อความล่าสุด
 * เกินเพดาน AI ของเว็บแล้วไม่สร้างให้เอง เจ้าหน้าที่ยังกด "แนะนำใหม่" ได้
 */
export async function ensureSuggestions(conversationId: string, now = Date.now()): Promise<SuggestionResult> {
  const db = supabaseAdmin();
  const empty = { id: null, options: [], needs_human: false };
  const { data: conv } = await db.from("conversations")
    .select("ai_mode, channels(type, ai_mode)").eq("id", conversationId).single();
  if (!conv) return empty;
  const channel = (Array.isArray(conv.channels) ? conv.channels[0] : conv.channels) as unknown as { type: ChannelType; ai_mode: AiMode | null };

  if (channel.type === "web") {
    const { data: usage } = await db.from("ai_daily_usage").select("count").eq("channel", "web").eq("day", bangkokDate(new Date(now))).maybeSingle();
    if ((usage?.count ?? 0) >= WEBCHAT_LIMITS.aiPerDay) return { ...empty, skipped: "cap" };
  }

  const mode = await resolveAiMode(conv as { ai_mode: AiMode | null }, channel);
  if (mode === "auto" || mode === "fallback") {
    const { data: lastIn } = await db.from("messages").select("created_at")
      .eq("conversation_id", conversationId).eq("direction", "in")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (lastIn && now - Date.parse(lastIn.created_at as string) < SERVER_DRAFT_WINDOW_MS) return { ...empty, skipped: "in_progress" };
  }
  return generateSuggestions(conversationId);
}

/** force = เจ้าหน้าที่กด "แนะนำใหม่": ข้ามกฎประหยัดทั้งหมดและเรียก LLM เสมอ */
export async function generateSuggestions(conversationId: string, { force = false } = {}): Promise<SuggestionResult> {
  const db = supabaseAdmin();

  const { data: rows } = await db
    .from("messages")
    .select("id, direction, sender_type, body, body_th, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(30);
  const msgs = ((rows ?? []) as MsgRow[]).reverse();
  const { text: question, lastId } = pendingCustomerText(msgs);
  // ส่งมาแต่รูป: AI ไม่เห็นรูป ไม่ต้องร่าง
  if (!question.trim()) return { id: null, options: [], needs_human: false, skipped: "no_reply_needed" };

  if (!force) {
    if (msgs.at(-1)?.direction !== "in") return { id: null, options: [], needs_human: false, skipped: "answered" };

    const lastOut = [...msgs].reverse().find((m) => m.direction === "out");
    if (shouldSkipSuggestion(question, lastOut ? lastOut.body_th || lastOut.body : null)) {
      return { id: null, options: [], needs_human: false, skipped: "no_reply_needed" };
    }

    // สร้างครั้งเดียวต่อชุดข้อความที่ยังไม่ตอบ
    const { data: existing } = await db.from("suggestions").select("id, options, needs_human, suggested_tags")
      .eq("conversation_id", conversationId).eq("trigger_message_id", lastId as string)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (existing) {
      return {
        id: existing.id,
        options: existing.options as SuggestionOption[],
        needs_human: existing.needs_human,
        suggested_tags: (existing.suggested_tags ?? []) as string[],
      };
    }
  }

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

  const starred = force ? null : pickStarredAnswer({ question, examples, knowledge, msgs });
  if (starred) {
    const { data: saved } = await db
      .from("suggestions")
      .insert({ conversation_id: conversationId, trigger_message_id: lastId, options: [starred], needs_human: false })
      .select("id")
      .single();
    return { id: saved?.id ?? null, options: [starred], needs_human: false };
  }

  const profile = await getSetting<{ name: string; tone: string }>("clinic_profile", DEFAULT_CLINIC_PROFILE);
  // คำตอบมาตรฐานของคลินิกเป็นตัวอย่างสำนวน ไม่นำเข้าแหล่งยืนยันตัวเลข
  const { data: starredRows } = await db.from("reply_examples").select("answer, starred")
    .eq("active", true).eq("starred", true).limit(50);
  const clinicStyle = pickStyleExamples((starredRows ?? []) as { answer: string; starred: boolean }[]);
  const { data: tagRows } = await db.from("tags").select("name").eq("active", true).order("sort");
  const tagNames = (tagRows ?? []).map((t) => t.name as string);

  // ---- แหล่งที่ 3: ประวัติของลูกค้าคนนี้ ----
  const history = msgs
    .slice(-20)
    .map((m) => `[${thDate(m.created_at)}] ${m.direction === "in" ? "ลูกค้า" : m.sender_type === "ai" ? "AI" : "เจ้าหน้าที่"}: ${m.body_th || m.body || "[รูปภาพ]"}`)
    .join("\n");

  const kBlock = knowledge.length
    ? knowledge.map((k) => `- [K:${k.id}] (${k.category}) ${k.title}: ${k.content} (อัปเดต ${thDate(k.updated_at)})`).join("\n")
    : "(ไม่พบข้อมูลที่เกี่ยวข้อง)";
  const eBlock = examples.length
    ? sortByStyle(examples).map((e) =>
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
- ทุกตัวเลือกต้องเป็นภาษาแชท 1–2 ประโยค ยาวสุด 3 บรรทัด ห้ามใช้ bullet หัวข้อ หรือตัวหนา ห้ามทวนคำถาม ห้ามขึ้นต้นด้วยการขอบคุณที่สอบถาม ถามกลับได้ครั้งละ 1 คำถาม
- ต้องให้อย่างน้อย 2 ตัวเลือก เรียงตามนี้: (1) สั้นที่สุด ตอบแค่ที่ถาม แต่ต้องครบเงื่อนไขในข้อมูล เช่น วันที่เริ่มใช้ (2) คำตอบเดียวกับข้อ 1 แล้วเพิ่มรายละเอียดจากข้อมูลที่ลูกค้าน่าจะถามต่อ (3) ถามกลับ 1 คำถาม เฉพาะเมื่อข้อมูลไม่พอ เขียนเป็นภาษาไทยเสมอ (ระบบจะแปลให้ลูกค้าเอง)
- ทุกตัวเลือกต้องตอบคำถามได้ด้วยตัวเอง ห้ามลงท้ายด้วยการเชิญชวนให้ถามเพิ่ม
- ความถูกต้องสำคัญกว่าความสั้น: ห้ามตัดเงื่อนไขที่ทำให้คำตอบเข้าใจผิด เช่น วันที่เริ่มใช้สิทธิ หรือรับเฉพาะบางโรงพยาบาล เรื่องอาการ ยา หรือฉุกเฉิน ต้องบอกให้ครบแม้จะยาวขึ้น
- ห้ามเดาเงื่อนไขการรับบริการ เช่น ต้องนัด ไม่ต้องนัด ฉีดได้เลย มาได้เลย ถ้าข้อมูลไม่ได้ระบุ
- source: "knowledge" ถ้าอิงฐานข้อมูลเป็นหลัก, "example" ถ้าอิงคำตอบเดิม, "history" ถ้าอิงประวัติลูกค้า
- ref_ids: id ที่อ้างอิง (ไม่ต้องใส่ K: หรือ E:)
- confidence 0–1: มั่นใจแค่ไหนว่าส่งได้เลยโดยไม่ต้องแก้
- suggested_tags: แท็กของแชทนี้ไม่เกิน 3 แท็ก เลือกจากรายการแท็กที่ให้เท่านั้น ห้ามสร้างชื่อใหม่ ถ้าไม่มีที่ตรงให้เป็น []

ตัวอย่างสำนวนที่ดี ใช้เป็นแบบความยาวและน้ำเสียงเท่านั้น ห้ามนำราคา เวลา หรือเงื่อนไขในตัวอย่างไปตอบ ข้อเท็จจริงต้องมาจากข้อมูลที่ให้เท่านั้น:
${[...STYLE_FEW_SHOT, ...clinicStyle.map((e) => e.answer)].map((s) => `- "${s}"`).join("\n")}

ตอบเป็น JSON:
{"needs_human": boolean, "reason": "เหตุผลสั้นๆ ถ้า needs_human", "suggested_tags": ["..."],
 "options": [{"text": "...", "source": "knowledge|example|history", "ref_ids": ["..."], "confidence": 0.0, "note": "ถ้ามี"}]}`;

  const user = `## ฐานข้อมูลคลินิก
${kBlock}

## คำตอบเดิมของเจ้าหน้าที่ที่คล้ายกัน
${eBlock}

## ประวัติแชทล่าสุดของลูกค้าคนนี้
${history}

## รายการแท็กที่เลือกได้
${tagNames.join(", ") || "(ไม่มี)"}

## ข้อความลูกค้าที่ต้องตอบตอนนี้
${question}`;

  const out = await chatJSON<{ needs_human?: boolean; reason?: string; suggested_tags?: unknown; options?: Partial<SuggestionOption>[] }>(system, user, 0.4);
  const suggested_tags = sanitizeSuggestedTags(out.suggested_tags, tagNames);

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
    .map((o) => applyNumberGuard(o, numberSources))
    .map((o) => applyClaimGuard(o, numberSources.trusted))
    .map((o) => applyLengthGuard(o, examples.filter((e) => e.starred).map((e) => e.answer)));

  const needs_human = !!out.needs_human;
  const { data: saved } = await db
    .from("suggestions")
    .insert({ conversation_id: conversationId, trigger_message_id: lastId, options, needs_human, suggested_tags })
    .select("id")
    .single();

  if (needs_human) {
    await db.from("conversations").update({ needs_human: true }).eq("id", conversationId);
  }

  return { id: saved?.id ?? null, options, needs_human, reason: out.reason, suggested_tags };
}
