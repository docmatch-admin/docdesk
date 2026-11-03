import { chatJSON, embed } from "./ai";
import {
  bookingCalendar, bookingOption, decideBooking, findUnavailableRequest, hasBookingSignal, localToday, maskBookingPii,
  resolveBookingDate, resolveBookingTime, type BookingRequest,
} from "./booking-rules";
import { activeBookings, loadBookingCatalog, loadBookingTemplates, loadBusinessHours, loadConversationBookings } from "./booking-store";
import { LAB_RULES } from "./lab-pricing";
import { loadLabContext } from "./lab-store";
import { bangkokDate } from "./llm-usage";
import { DEFAULT_CLINIC_PROFILE, getSetting, isWithinBusinessHours, resolveAiMode } from "./mode";
import { META_FALLBACK_NAME } from "./channels/meta";
import { applyNumberGuard, buildNumberSources } from "./number-guard";
import { applyPriceConflictGuard, buildPriceEntries, findPriceConflicts, noPriceAnswer, type WebsitePriceRow } from "./price-catalog";
import { scrubPII } from "./pii";
import { applySensitiveGuard, SENSITIVE_PROMPT_RULES, SENSITIVE_TAG } from "./sensitive-rules";
import { loadSensitiveKeywords, markConversationSensitive } from "./sensitive-store";
import { applyClaimGuard, applyLengthGuard, applySameChannelGuard, hasUrgentSignal, pickStarredAnswer, pickStyleExamples, shouldSkipSuggestion, sortByStyle } from "./suggest-rules";
import { supabaseAdmin } from "./supabase/admin";
import { applySymptomGuards, findRedFlag, hasEnoughSymptomInfo, hasSymptomSignal, SYMPTOM_GUIDE_CATEGORY, symptomPromptRules, todayHoursText } from "./symptom-rules";
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
export async function generateSuggestions(conversationId: string, { force = false, now = Date.now() } = {}): Promise<SuggestionResult> {
  const db = supabaseAdmin();

  const { data: rows } = await db
    .from("messages")
    .select("id, direction, sender_type, body, body_th, created_at")
    .eq("conversation_id", conversationId)
    .neq("imported", true) // ประวัติเก่าอาจมีราคาเก่า
    .neq("sender_type", "system") // ข้อความอัตโนมัติของเพจไม่ใช่การตอบ
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

  // ข้อมูลที่ไม่ขึ้นกับคำถามดึงพร้อมกันทีเดียว ทุกคำสั่งคือ round trip ไป Supabase การรอทีละตัวทำให้ร่างช้าหลายวินาที
  const customerText = msgs.filter((m) => m.direction === "in").map((m) => m.body_th || m.body).join("\n");
  const symptomSignal = hasSymptomSignal(question) || !!findRedFlag(customerText);
  const noRows = { data: [] as KnowledgeHit[] };
  const sharedP = Promise.all([
    db.from("knowledge_items").select("id, category, title, content, updated_at").eq("active", true).in("category", ALWAYS_INCLUDED_CATEGORIES),
    // ระบุคอลัมน์เสมอ ที่นี่ใช้ service role ซึ่งอ่านต้นทุนได้
    db.from("knowledge_items").select("website_slug, title, content").eq("source", "website").eq("active", true),
    db.from("lab_items").select("code, name_en, name_th, price").eq("active", true),
    db.from("lab_packages").select("name, price").eq("active", true),
    // เรื่องอาการ: แนวทางที่แพทย์อนุมัติแล้วและสิทธิการรักษาส่งให้ AI เสมอ ร่างไม่ส่ง
    symptomSignal
      ? db.from("knowledge_items").select("id, category, title, content, updated_at")
        .eq("active", true).eq("review_status", "approved").in("category", [SYMPTOM_GUIDE_CATEGORY, "สิทธิการรักษา"])
      : Promise.resolve(noRows),
    db.from("conversations").select("tags, sensitive, channels(type, name)").eq("id", conversationId).maybeSingle(),
    // คำขอจองต้องผ่านการตรวจวันเวลาทุกครั้ง
    loadBusinessHours(),
    getSetting<{ name: string; tone: string }>("clinic_profile", DEFAULT_CLINIC_PROFILE),
    // คำตอบมาตรฐานของคลินิกเป็นตัวอย่างสำนวน ไม่นำเข้าแหล่งยืนยันตัวเลข
    db.from("reply_examples").select("answer, starred").eq("active", true).eq("starred", true).limit(50),
    db.from("tags").select("name").eq("active", true).order("sort"),
    loadBookingCatalog(),
  ]);
  // คำถามราคาแล็บต้องใช้ราคาล่าสุดจากตาราง เริ่มทันทีที่รู้แท็กของแชท ไม่ต้องรอ embedding
  const labContextP = sharedP.then(([, , , , , { data: tagged }]) => loadLabContext(question, (tagged?.tags ?? []) as string[]));
  // ถ้าขั้นอื่นล้มก่อนถึงจุดรอ ไม่ให้กลายเป็น unhandled rejection ตอนรอจริงยังโยน error เหมือนเดิม
  sharedP.catch(() => {});
  labContextP.catch(() => {});

  // ชื่อและเบอร์ของนัดเดิมห้ามส่งให้ AI เบอร์ทุกเบอร์ดึงด้วยโค้ดตอนบันทึกนัด AI จึงไม่ต้องเห็น
  const bookings = await loadConversationBookings(conversationId);
  const forAi = (text: string) => scrubPII(maskBookingPii(text, bookings));
  const safeQuestion = forAi(question);

  // ---- ค้น 2 แหล่งด้วย vector search ----
  const qEmbedding = await embed(safeQuestion);
  const vec = JSON.stringify(qEmbedding);
  const [{ data: kRaw }, { data: eRaw }, [
    { data: policy }, { data: websiteRows }, { data: labRows }, { data: packageRows }, { data: guideRows },
    { data: convTags }, hours, profile, { data: starredRows }, { data: tagRows }, catalog,
  ], labContext] = await Promise.all([
    db.rpc("match_knowledge", { query_embedding: vec, match_count: 6 }),
    db.rpc("match_examples", { query_embedding: vec, match_count: 5 }),
    sharedP,
    labContextP,
  ]);
  const knowledge = ((kRaw ?? []) as KnowledgeHit[]).filter((k) => k.similarity >= KNOWLEDGE_MIN_SIM);
  const priceEntries = buildPriceEntries(
    (websiteRows ?? []) as WebsitePriceRow[],
    (labRows ?? []) as { code: string; name_en: string; name_th: string; price: number | null }[],
    (packageRows ?? []) as { name: string; price: number }[],
  );
  for (const p of (policy ?? []) as KnowledgeHit[]) {
    if (!knowledge.some((k) => k.id === p.id)) knowledge.push({ ...p, similarity: 1 });
  }
  // คำตอบเก่าที่ราคาขัดกับข้อมูลปัจจุบัน ไม่ให้ AI เห็นเลย กันลอกราคาเก่า
  for (const g of (guideRows ?? []) as KnowledgeHit[]) {
    if (!knowledge.some((k) => k.id === g.id)) knowledge.push({ ...g, similarity: 1 });
  }
  const approvedGuides = knowledge.filter((k) => k.category === SYMPTOM_GUIDE_CATEGORY).map((k) => `${k.title}\n${k.content}`);

  const examples = ((eRaw ?? []) as ExampleHit[])
    .filter((e) => e.similarity >= EXAMPLE_MIN_SIM)
    .filter((e) => !findPriceConflicts(e.answer, e.question, priceEntries).length);

  const alreadySensitive = !!convTags?.sensitive;
  const channelRaw = (convTags as { channels?: unknown } | null)?.channels;
  const channelRow = (Array.isArray(channelRaw) ? channelRaw[0] : channelRaw) as { type: ChannelType; name?: string | null } | null | undefined;
  const convChannel = channelRow?.name ? { type: channelRow.type, name: channelRow.name } : null;

  // คำตอบติดดาวอาจเป็นราคาเก่า คำถามราคาแล็บ นัด แชทลับ และอาการ จึงต้องผ่าน LLM
  const current = activeBookings(bookings, localToday(now, hours.tz || "Asia/Bangkok"))[0] ?? null;
  const starred = force || labContext || current || alreadySensitive || symptomSignal || hasBookingSignal(question) ? null : pickStarredAnswer({ question, examples, knowledge, msgs, priceEntries });
  if (starred) {
    const { data: saved } = await db
      .from("suggestions")
      .insert({ conversation_id: conversationId, trigger_message_id: lastId, options: [starred], needs_human: false })
      .select("id")
      .single();
    return { id: saved?.id ?? null, options: [starred], needs_human: false };
  }

  const clinicStyle = pickStyleExamples((starredRows ?? []) as { answer: string; starred: boolean }[]);
  // แท็กลับคู่กับสถานะแชทลับ AI บอกผ่าน sensitive แทน
  const tagNames = (tagRows ?? []).map((t) => t.name as string).filter((t) => t !== SENSITIVE_TAG);

  // ---- แหล่งที่ 3: ประวัติของลูกค้าคนนี้ ----
  const history = msgs
    .slice(-20)
    .map((m) => `[${thDate(m.created_at)}] ${m.direction === "in" ? "ลูกค้า" : m.sender_type === "ai" ? "AI" : "เจ้าหน้าที่"}: ${forAi(m.body_th || m.body || "[รูปภาพ]")}`)
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
- ราคาใช้จาก [K] และ "ราคาแล็บ" เท่านั้น ราคาในคำตอบเดิมและประวัติแชทอาจเก่า ห้ามนำมาตอบ
- บริการที่เขียนว่า "ไม่มีราคาบนเว็บ" ห้ามบอกหรือเดาตัวเลขราคา ให้ตอบตามข้อความที่ระบุไว้
- ถ้าคำตอบเดิม [E] ขัดกับฐานข้อมูล [K] ให้ใช้ข้อมูลจาก [K] และใส่ note อธิบายสั้นๆ
${symptomPromptRules(approvedGuides.length > 0)}
- ผลแล็บ หรือการใช้ยา/ขนาดยาที่แพทย์สั่ง: needs_human = true ห้ามแปลผลหรือแนะนำยาเอง
- ลูกค้าขอคุยกับคน/ไม่พอใจ/ร้องเรียน: needs_human = true
${convChannel ? `- ลูกค้าคุยกับคลินิกผ่าน ${convChannel.name} อยู่แล้ว ห้ามบอกให้ติดต่อ ส่งข้อมูล หรือขอใบเสนอราคาผ่านช่องทางนี้ และห้ามให้ไอดีหรือลิงก์ของช่องทางนี้ ให้บอกว่าส่งในแชทนี้ได้เลย\n` : ""}- ตอบข้อความล่าสุดของลูกค้าเป็นหลัก ถ้าลูกค้าบอกว่าขอคิดก่อน ขอปรึกษาก่อน หรือขอบคุณเพื่อจบการคุย ให้ตอบรับสั้นๆ อย่างสุภาพ ไม่ต้องตอบคำถามก่อนหน้าซ้ำ
- [รูปภาพ] ในประวัติคือรูปที่ลูกค้าส่ง คุณมองไม่เห็นเนื้อหารูป ห้ามเดาว่าในรูปมีอะไร ถ้าคำตอบต้องใช้ข้อมูลในรูปให้ needs_human = true
- ทุกตัวเลือกต้องเป็นภาษาแชท 1–2 ประโยค ยาวสุด 3 บรรทัด ห้ามใช้ bullet หัวข้อ หรือตัวหนา ห้ามทวนคำถาม ห้ามขึ้นต้นด้วยการขอบคุณที่สอบถาม ถามกลับได้ครั้งละ 1 คำถาม
- ต้องให้อย่างน้อย 2 ตัวเลือก เรียงตามนี้: (1) สั้นที่สุด ตอบแค่ที่ถาม แต่ต้องครบเงื่อนไขในข้อมูล เช่น วันที่เริ่มใช้ (2) คำตอบเดียวกับข้อ 1 แล้วเพิ่มรายละเอียดจากข้อมูลที่ลูกค้าน่าจะถามต่อ (3) ถามกลับ 1 คำถาม เฉพาะเมื่อข้อมูลไม่พอ เขียนเป็นภาษาไทยเสมอ (ระบบจะแปลให้ลูกค้าเอง)
- ทุกตัวเลือกต้องตอบคำถามได้ด้วยตัวเอง ห้ามลงท้ายด้วยการเชิญชวนให้ถามเพิ่ม
- ความถูกต้องสำคัญกว่าความสั้น: ห้ามตัดเงื่อนไขที่ทำให้คำตอบเข้าใจผิด เช่น วันที่เริ่มใช้สิทธิ หรือรับเฉพาะบางโรงพยาบาล เรื่องอาการ ยา หรือฉุกเฉิน ต้องบอกให้ครบแม้จะยาวขึ้น
- ห้ามเดาเงื่อนไขการรับบริการ เช่น ต้องนัด ไม่ต้องนัด ฉีดได้เลย มาได้เลย ถ้าข้อมูลไม่ได้ระบุ
- source: "knowledge" ถ้าอิงฐานข้อมูลเป็นหลัก, "example" ถ้าอิงคำตอบเดิม, "history" ถ้าอิงประวัติลูกค้า
- ref_ids: id ที่อ้างอิง (ไม่ต้องใส่ K: หรือ E:)
- confidence 0–1: มั่นใจแค่ไหนว่าส่งได้เลยโดยไม่ต้องแก้
- suggested_tags: แท็กของแชทนี้ไม่เกิน 3 แท็ก เลือกจากรายการแท็กที่ให้เท่านั้น ห้ามสร้างชื่อใหม่ ถ้าไม่มีที่ตรงให้เป็น []
${labContext ? `${LAB_RULES}\n` : ""}- intent: "booking" เมื่อลูกค้าต้องการจองหรือเปลี่ยนเวลานัดตอนนี้ หรือกำลังตอบวันเวลาที่คลินิกถาม "symptom" เมื่อเล่าอาการป่วยหรือถามเรื่องอาการ ถ้าแค่ถามข้อมูล เช่น ต้องนัดไหม เปิดกี่โมง ให้เป็น "other"
- ลูกค้าขอยกเลิกนัด: intent "other" และ needs_human = true
- sensitive: true เมื่อเป็นเรื่องโรคติดต่อทางเพศ การตรวจหรือรักษาเกี่ยวกับเพศสัมพันธ์ หรือความเสี่ยงทางเพศ
${alreadySensitive ? `${SENSITIVE_PROMPT_RULES}\n` : ""}- customer_name: ชื่อที่ลูกค้าบอกว่าเป็นชื่อของตัวเองในแชท เช่น "ชื่อมิ้นท์ค่ะ" ให้ตอบ "มิ้นท์" ใช้คำตามที่ลูกค้าพิมพ์ ไม่เติมคำนำหน้า ถ้าไม่ได้บอก หรือเป็นชื่อคนอื่น เช่น ลูก แม่ ผู้ป่วย ให้เป็น null ห้ามเดา
- booking: ดึงจากประวัติแชททั้งหมด ไม่ต้องขอชื่อหรือเบอร์ ห้ามเดาค่าที่ลูกค้าไม่ได้บอก ให้เป็น null
  - service: ชื่อบริการที่ลูกค้าต้องการ ถ้าตรงกับรายการบริการให้ใช้ชื่อในรายการ ถ้าไม่มีในรายการให้ใช้คำของลูกค้า ห้ามเปลี่ยนเป็นบริการอื่น
  - date: YYYY-MM-DD ปี ค.ศ. จากปฏิทินที่ให้ / time: HH:MM แบบ 24 ชั่วโมง เช่น บ่าย 3 = 15:00
  - name: ชื่อที่ลูกค้าบอกเองในแชท ถ้าไม่ได้บอกให้เป็น null
  - is_change: true เมื่อขอเปลี่ยนวันเวลาของนัดเดิม
  - ไม่ต้องตัดสินว่ารับนัดได้ไหม ระบบตรวจเอง แม้บริการไม่มีหรือเวลาปิดก็ยังเป็น intent "booking" และไม่ต้องตั้ง needs_human เพราะเหตุนั้น

ตัวอย่างสำนวนที่ดี ใช้เป็นแบบความยาวและน้ำเสียงเท่านั้น ห้ามนำราคา เวลา หรือเงื่อนไขในตัวอย่างไปตอบ ข้อเท็จจริงต้องมาจากข้อมูลที่ให้เท่านั้น:
${[...STYLE_FEW_SHOT, ...clinicStyle.map((e) => e.answer)].map((s) => `- "${s}"`).join("\n")}

ตอบเป็น JSON:
{"needs_human": boolean, "reason": "เหตุผลสั้นๆ ถ้า needs_human", "suggested_tags": ["..."],
 "sensitive": false, "customer_name": null, "intent": "booking|symptom|other", "red_flag": false, "booking": {"service": "...", "date": "YYYY-MM-DD", "time": "HH:MM", "name": null, "is_change": false},
 "options": [{"text": "...", "source": "knowledge|example|history", "ref_ids": ["..."], "confidence": 0.0, "kind": "ask|advice|other", "note": "ถ้ามี"}]}`;

  const user = `## ฐานข้อมูลคลินิก
${kBlock}
${labContext ? `\n## ราคาแล็บ\n${labContext}\n` : ""}
## คำตอบเดิมของเจ้าหน้าที่ที่คล้ายกัน
${eBlock}

## ประวัติแชทล่าสุดของลูกค้าคนนี้
${history}

## รายการแท็กที่เลือกได้
${tagNames.join(", ") || "(ไม่มี)"}

## เวลาเปิดวันนี้
${todayHoursText(hours, new Date(now))}

## ปฏิทินสำหรับการจอง
${bookingCalendar(now, hours.tz || "Asia/Bangkok")}

## รายการบริการ
${catalog.names.join(", ") || "(ไม่มี)"}

## นัดปัจจุบันของลูกค้า
${current ? `${current.service} ${current.date} ${current.time.slice(0, 5)}` : "(ไม่มี)"}

## ข้อความลูกค้าที่ต้องตอบตอนนี้
${safeQuestion}`;

  // คำตอบที่นำเข้ามาจากอดีต ใช้เป็นแบบสำนวนได้แต่ไม่ยืนยันตัวเลข ดึงไว้ระหว่างรอ LLM
  const importedP = examples.length
    ? Promise.resolve(db.from("reply_examples").select("id").in("id", examples.map((e) => e.id)).in("source", ["line_import", "manual_paste"]))
    : Promise.resolve({ data: [] as { id: string }[] });
  importedP.catch(() => {});
  const out = await chatJSON<{ customer_name?: unknown; needs_human?: boolean; reason?: string; suggested_tags?: unknown; sensitive?: boolean; intent?: string; red_flag?: boolean; booking?: BookingRequest; options?: Partial<SuggestionOption>[] }>(system, user, 0.4);
  const suggested_tags = sanitizeSuggestedTags(out.suggested_tags, tagNames);
  const detectedName = pickDetectedName(out.customer_name, customerText);
  if (detectedName) await saveDetectedName(conversationId, detectedName).catch((e) => console.error("save detected name failed", e?.code ?? e?.name));

  const validSources: SuggestionSource[] = ["knowledge", "example", "history"];
  const knownIds = new Set([...knowledge.map((k) => k.id), ...examples.map((e) => e.id)]);
  const { data: importedRows } = await importedP;
  const importedIds = new Set(((importedRows ?? []) as { id: string }[]).map((e) => e.id));
  // คำถามราคาแล็บไม่เชื่อตัวเลขจากคำตอบเดิม เพราะอาจเป็นราคาก่อนแก้ตาราง
  const numberSources = buildNumberSources({
    knowledge,
    examples: labContext ? [] : examples.filter((e) => !importedIds.has(e.id)),
    msgs,
    // เวลาเปิดวันนี้มาจากค่าตั้งเวลาทำการ ใช้ยืนยันเวลาในคำตอบได้
    extraTrusted: [...(labContext ? [labContext] : []), todayHoursText(hours, new Date(now))],
  });
  let options: SuggestionOption[] = (out.options ?? [])
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
    .map((o) => applyPriceConflictGuard(o, question, priceEntries))
    .map((o) => applyClaimGuard(o, numberSources.trusted))
    .map((o) => applySameChannelGuard(o, convChannel))
    .map((o) => applyLengthGuard(o, examples.filter((e) => e.starred).map((e) => e.answer)));

  // บริการไม่มีราคา: ตัวเลือกแรกเป็นข้อความจากเว็บ ไม่ขึ้นกับ AI
  const noPrice = noPriceAnswer(question, priceEntries);
  if (noPrice) options = [{ text: noPrice, source: "knowledge" as const, ref_ids: [], confidence: 0.9 }, ...options].slice(0, 3);

  // การจองตอบจากเทมเพลตที่โค้ดตรวจแล้วเป็นตัวเลือกแรก
  let needs_human = !!out.needs_human;
  const sensitive = alreadySensitive || out.sensitive === true;
  const unavailableAsked = sensitive ? null : findUnavailableRequest(safeQuestion, catalog);
  const today = localToday(now, hours.tz || "Asia/Bangkok");
  const bookingDate = resolveBookingDate(safeQuestion, out.booking?.date, today);
  const bookingTime = resolveBookingTime(safeQuestion, out.booking?.time);
  // พูดว่าจองพร้อมวันเวลาชัดเจน: AI จัดเป็นเรื่องอื่นได้เมื่อเวลาแปลก เช่น เวลาที่ผ่านไปแล้ว
  const explicitRequest = /จอง|ขอนัด/.test(safeQuestion) && !!bookingDate && !!bookingTime;
  // แชทลับไม่ใช้เทมเพลตจอง เพราะข้อความระบุชื่อบริการ
  if (!sensitive && (out.intent === "booking" || unavailableAsked || explicitRequest)) {
    const decision = decideBooking({
      ...out.booking,
      service: out.booking?.service || unavailableAsked,
      date: bookingDate,
      time: bookingTime,
    }, { catalog, hours, now, current });
    options = [bookingOption(decision, await loadBookingTemplates()), ...options].slice(0, 3);
    // ปฏิเสธหรือเสนอเวลาอื่นไม่ได้รับปากอะไร ตอบได้เลย เว้นแต่มีเรื่องด่วน ไม่ใช้ hasSensitiveSignal เพราะติดคำว่าไข้ใน "วัคซีนไข้หวัดใหญ่"
    const noCommitment = decision.action === "unavailable" || decision.action === "offer_closed" || decision.action === "offer_past";
    if (noCommitment && !hasUrgentSignal(question)) needs_human = false;
  }
  // เรื่องอาการ: โค้ดคัดกรอง red flag และกันคำแนะนำที่แพทย์ยังไม่อนุมัติ ไม่เชื่อ AI อย่างเดียว
  const redFlag = findRedFlag(customerText) ?? (out.red_flag === true ? "AI ประเมินว่ามีสัญญาณอันตราย" : null);
  if (redFlag || (out.intent === "symptom" && !sensitive) || (symptomSignal && out.intent !== "booking" && !sensitive)) {
    const guarded = applySymptomGuards(options, {
      redFlag,
      approvedGuides,
      withinHours: isWithinBusinessHours(hours, new Date(now)),
      enoughInfo: hasEnoughSymptomInfo(customerText),
      make: (text, confidence, note) => ({ text, source: "knowledge" as const, ref_ids: [], confidence, ...(note ? { note } : {}) }),
    });
    options = guarded.options;
    needs_human = guarded.needsHuman;
  }
  if (sensitive) {
    needs_human = true;
    const keywords = await loadSensitiveKeywords();
    options = options.map((o) => applySensitiveGuard(o, keywords));
    if (!alreadySensitive) await markConversationSensitive(conversationId, "AI");
  }

  const [{ data: saved }] = await Promise.all([
    db.from("suggestions")
      .insert({ conversation_id: conversationId, trigger_message_id: lastId, options, needs_human, suggested_tags })
      .select("id")
      .single(),
    needs_human ? db.from("conversations").update({ needs_human: true }).eq("id", conversationId) : null,
  ]);

  return { id: saved?.id ?? null, options, needs_human, reason: out.reason, suggested_tags };
}

/** ชื่อชั่วคราวที่ระบบตั้งให้ ยังไม่ใช่ชื่อจริงของลูกค้า */
const PLACEHOLDER_NAMES = new Set<string>(["", "ลูกค้า", ...Object.values(META_FALLBACK_NAME)]);

/** ชื่อที่ AI จับได้ ต้องเป็นคำที่ลูกค้าพิมพ์เองจริง กัน AI เดาหรือหยิบชื่อเจ้าหน้าที่ */
export function pickDetectedName(raw: unknown, customerText: string): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  const len = [...name].length;
  if (len < 2 || len > 40 || /[\d@[\]<>]/.test(name)) return null;
  return customerText.replace(/\s+/g, " ").includes(name) ? name : null;
}

/** ใช้เฉพาะลูกค้าที่ยังไม่มีชื่อจริงและเจ้าหน้าที่ไม่ได้ล็อกชื่อ ไม่ล็อก เจ้าหน้าที่แก้ต่อได้ */
async function saveDetectedName(conversationId: string, name: string) {
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("contact_id").eq("id", conversationId).maybeSingle();
  if (!conv) return;
  const { data: c } = await db.from("contacts").select("display_name, name_locked").eq("id", conv.contact_id as string).maybeSingle();
  if (!c || c.name_locked || !PLACEHOLDER_NAMES.has(((c.display_name as string | null) ?? "").trim())) return;
  await db.from("contacts").update({ display_name: name }).eq("id", conv.contact_id as string);
}
