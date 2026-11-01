import { embed } from "./ai";
import { sendToChannel } from "./channels";
import { claimReplyToken } from "./channels/reply-token";
import { getSetting, isWithinBusinessHours, resolveAiMode, type BusinessHours } from "./mode";
import { scrubPII } from "./pii";
import { AUTO_SEND_MIN_CONFIDENCE, generateSuggestions, pendingCustomerText } from "./suggest";
import { supabaseAdmin } from "./supabase/admin";
import { fromThai, toThai } from "./translate";
import type { AiMode, ChannelType, SuggestionOption } from "./types";

const preview = (s: string) => s.replace(/\s+/g, " ").slice(0, 120);

// ---------------------------------------------------------------------------
// ขาเข้า: ข้อความจากลูกค้า
// ---------------------------------------------------------------------------
export interface IncomingInput {
  channelType: ChannelType;
  externalId: string;
  text: string;
  displayName?: string;
  avatarUrl?: string;
  externalMessageId?: string;
  replyToken?: string;
}

/** บันทึกข้อความเข้า แล้วคืน conversationId (เร็ว ใช้ก่อนตอบ webhook) */
export async function storeIncoming(input: IncomingInput) {
  const db = supabaseAdmin();

  const { data: channel, error: chErr } = await db
    .from("channels").select("id, type, ai_mode").eq("type", input.channelType).eq("enabled", true)
    .order("created_at").limit(1).single();
  if (chErr || !channel) throw new Error(`ไม่พบช่องทาง ${input.channelType} ที่เปิดใช้งาน`);

  const contactPatch: Record<string, unknown> = { channel_id: channel.id, external_id: input.externalId };
  if (input.displayName) contactPatch.display_name = input.displayName;
  if (input.avatarUrl) contactPatch.avatar_url = input.avatarUrl;
  const { data: contact, error: ctErr } = await db
    .from("contacts").upsert(contactPatch, { onConflict: "channel_id,external_id" })
    .select("id, language").single();
  if (ctErr || !contact) throw ctErr ?? new Error("contact upsert failed");

  // dedupe: LINE อาจส่ง webhook ซ้ำ
  if (input.externalMessageId) {
    const { data: dup } = await db.from("messages").select("id, conversation_id")
      .eq("external_id", input.externalMessageId).maybeSingle();
    if (dup) return { conversationId: dup.conversation_id as string, messageId: dup.id as string, duplicate: true };
  }

  const { data: conv, error: cvErr } = await db
    .from("conversations")
    .upsert({ contact_id: contact.id, channel_id: channel.id }, { onConflict: "contact_id" })
    .select("id, unread_count").single();
  if (cvErr || !conv) throw cvErr ?? new Error("conversation upsert failed");

  const { language, th } = await toThai(input.text);

  const { data: msg, error: mErr } = await db.from("messages").insert({
    conversation_id: conv.id,
    direction: "in",
    sender_type: "customer",
    body: input.text,
    body_th: th,
    language,
    external_id: input.externalMessageId ?? null,
  }).select("id").single();
  if (mErr || !msg) throw mErr ?? new Error("message insert failed");

  await Promise.all([
    db.from("contacts").update({ language }).eq("id", contact.id),
    db.from("conversations").update({
      status: "open",
      unread_count: (conv.unread_count ?? 0) + 1,
      last_message_at: new Date().toISOString(),
      last_message_preview: preview(th ?? input.text),
      ...(input.replyToken
        ? { line_reply_token: input.replyToken, line_reply_token_at: new Date().toISOString() }
        : {}),
    }).eq("id", conv.id),
  ]);

  return { conversationId: conv.id as string, messageId: msg.id as string, duplicate: false };
}

/** หลังบันทึก: สร้างคำแนะนำ แล้วตัดสินใจตามโหมด AI (เรียกใน after()) */
export async function processIncoming(conversationId: string, replyToken?: string) {
  const db = supabaseAdmin();
  const { data: conv } = await db
    .from("conversations").select("id, ai_mode, channels(ai_mode)").eq("id", conversationId).single();
  if (!conv) return;

  const channel = (Array.isArray(conv.channels) ? conv.channels[0] : conv.channels) as { ai_mode: AiMode | null };
  const mode = await resolveAiMode(conv as { ai_mode: AiMode | null }, channel ?? { ai_mode: null });
  const suggestion = await generateSuggestions(conversationId);

  if (mode === "off" || mode === "assist") return;

  if (mode === "fallback") {
    const hours = await getSetting<BusinessHours>("business_hours", { tz: "Asia/Bangkok", days: {} });
    if (isWithinBusinessHours(hours)) {
      const minutes = await getSetting<number>("fallback_minutes", 5);
      await db.from("conversations")
        .update({ ai_due_at: new Date(Date.now() + minutes * 60_000).toISOString() })
        .eq("id", conversationId);
      return;
    }
    // นอกเวลาทำการ → ตอบทันทีเหมือนโหมด auto
  }

  await tryAutoSend(conversationId, suggestion.options, suggestion.needs_human, suggestion.id, replyToken);
}

/** AI ส่งเองเมื่อมั่นใจพอและไม่ใช่เรื่องที่ต้องให้คนดูแล */
export async function tryAutoSend(
  conversationId: string,
  options: SuggestionOption[],
  needsHuman: boolean,
  suggestionId: string | null,
  replyToken?: string,
): Promise<boolean> {
  const best = [...options].sort((a, b) => b.confidence - a.confidence)[0];
  if (needsHuman || !best || best.confidence < AUTO_SEND_MIN_CONFIDENCE) {
    await supabaseAdmin().from("conversations").update({ needs_human: true, ai_due_at: null }).eq("id", conversationId);
    return false;
  }
  try {
    await sendReply({
      conversationId,
      textTh: best.text,
      senderType: "ai",
      suggestionId,
      chosenIndex: options.indexOf(best),
      replyToken,
    });
  } catch (e) {
    // ส่งไม่สำเร็จ (เช่น เกินกรอบเวลาของ Meta) → ส่งต่อให้คนดูแล
    console.error("AI auto-send failed", e);
    await supabaseAdmin().from("conversations").update({ needs_human: true, ai_due_at: null }).eq("id", conversationId);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// ขาออก: เจ้าหน้าที่ / AI ตอบลูกค้า
// ---------------------------------------------------------------------------
export interface ReplyInput {
  conversationId: string;
  textTh: string;               // ข้อความภาษาไทย (ระบบแปลให้)
  senderType: "staff" | "ai";
  senderId?: string;
  suggestionId?: string | null; // ถ้าเลือกมาจากคำแนะนำ
  chosenIndex?: number | null;
  replyToken?: string;
  skipTranslate?: boolean;      // เจ้าหน้าที่พิมพ์เป็นภาษาลูกค้าเองแล้ว
}

export async function sendReply(input: ReplyInput) {
  const db = supabaseAdmin();
  const { data: conv, error } = await db
    .from("conversations")
    .select("id, contacts(external_id, language), channels(type)")
    .eq("id", input.conversationId).single();
  if (error || !conv) throw error ?? new Error("conversation not found");

  const contact = (Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts) as { external_id: string; language: string };
  const channel = (Array.isArray(conv.channels) ? conv.channels[0] : conv.channels) as { type: ChannelType };

  const language = input.skipTranslate ? "th" : contact.language || "th";
  const body = language === "th" ? input.textTh : await fromThai(input.textTh, language);

  let lastInboundAt: Date | null = null;
  if (channel.type === "facebook" || channel.type === "instagram") {
    const { data: lastIn } = await db.from("messages").select("created_at")
      .eq("conversation_id", input.conversationId).eq("direction", "in")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    lastInboundAt = lastIn ? new Date(lastIn.created_at as string) : null;
  }
  const replyToken = channel.type === "line" ? await claimReplyToken(db, input.conversationId) : undefined;
  await sendToChannel(channel.type, contact.external_id, body, {
    replyToken, lastInboundAt, senderType: input.senderType,
  });

  const { data: msg } = await db.from("messages").insert({
    conversation_id: input.conversationId,
    direction: "out",
    sender_type: input.senderType,
    sender_id: input.senderId ?? null,
    body,
    body_th: language === "th" ? null : input.textTh,
    language,
  }).select("id").single();

  await db.from("conversations").update({
    unread_count: 0,
    ai_due_at: null,
    ...(input.senderType === "staff" ? { needs_human: false } : {}),
    last_message_at: new Date().toISOString(),
    last_message_preview: preview(input.textTh),
  }).eq("id", input.conversationId);

  if (input.senderType === "staff") {
    await learnFromStaffReply(input, msg?.id ?? null).catch((e) => console.error("learn failed", e));
  } else if (input.suggestionId != null && input.chosenIndex != null) {
    await db.from("suggestions").update({ chosen_index: input.chosenIndex, edited: false }).eq("id", input.suggestionId);
  }

  return { messageId: msg?.id ?? null, body };
}

// ---------------------------------------------------------------------------
// เรียนรู้: เก็บ "คำถาม → คำตอบเจ้าหน้าที่" + log ว่าเลือก/แก้คำแนะนำไหม
// ---------------------------------------------------------------------------
async function learnFromStaffReply(input: ReplyInput, messageId: string | null) {
  const db = supabaseAdmin();
  let chosen: SuggestionOption | null = null;

  if (input.suggestionId) {
    const { data: s } = await db.from("suggestions").select("options").eq("id", input.suggestionId).single();
    const opts = (s?.options ?? []) as SuggestionOption[];
    chosen = input.chosenIndex != null ? opts[input.chosenIndex] ?? null : null;
    const edited = chosen ? chosen.text.trim() !== input.textTh.trim() : null;
    await db.from("suggestions")
      .update({ chosen_index: chosen ? input.chosenIndex : null, edited })
      .eq("id", input.suggestionId);
    if (chosen?.source === "example" && chosen.ref_ids.length) {
      await db.rpc("increment_example_use", { example_ids: chosen.ref_ids });
      // เลือกคำตอบเดิมโดยไม่แก้ → ไม่ต้องเก็บซ้ำ
      if (!edited) return;
    }
  }

  // คำถามลูกค้าก่อนหน้าข้อความที่เพิ่งส่ง
  const { data: rows } = await db.from("messages")
    .select("id, direction, sender_type, body, body_th, created_at")
    .eq("conversation_id", input.conversationId)
    .order("created_at", { ascending: false }).limit(15);
  const msgs = (rows ?? []).reverse().filter((m) => m.id !== messageId);
  const { text: question } = pendingCustomerText(msgs as never);

  const q = scrubPII(question).trim();
  const a = scrubPII(input.textTh).trim();
  if (q.length < 3 || a.length < 4) return;

  const embedding = await embed(q);
  await db.from("reply_examples").insert({
    question: q,
    answer: a,
    embedding: JSON.stringify(embedding),
    source_message_id: messageId,
    created_by: input.senderId ?? null,
  });
}

/** กดดาว: บันทึกข้อความนี้เป็นคำตอบมาตรฐาน */
export async function starMessage(messageId: string, staffId: string) {
  const db = supabaseAdmin();
  const { data: m } = await db.from("messages")
    .select("id, conversation_id, direction, body, body_th, created_at").eq("id", messageId).single();
  if (!m || m.direction !== "out") throw new Error("กดดาวได้เฉพาะข้อความที่คลินิกตอบ");

  await db.from("messages").update({ starred: true }).eq("id", messageId);

  const { data: existing } = await db.from("reply_examples").select("id").eq("source_message_id", messageId).maybeSingle();
  if (existing) {
    await db.from("reply_examples").update({ starred: true, active: true }).eq("id", existing.id);
    return;
  }

  const { data: before } = await db.from("messages")
    .select("id, direction, sender_type, body, body_th, created_at")
    .eq("conversation_id", m.conversation_id).lt("created_at", m.created_at)
    .order("created_at", { ascending: false }).limit(10);
  const { text: question } = pendingCustomerText((before ?? []).reverse() as never);
  const q = scrubPII(question).trim() || "(ไม่มีคำถาม)";
  const a = scrubPII(m.body_th || m.body).trim();
  await db.from("reply_examples").insert({
    question: q, answer: a, starred: true, source_message_id: messageId, created_by: staffId,
    embedding: JSON.stringify(await embed(q)),
  });
}

// ---------------------------------------------------------------------------
// โหมด "คนตอบก่อน": เรียกทุกนาทีจาก cron
// ---------------------------------------------------------------------------
export async function runFallback() {
  const db = supabaseAdmin();
  const { data: due } = await db.from("conversations")
    .select("id").lte("ai_due_at", new Date().toISOString()).limit(20);

  let sent = 0;
  for (const c of due ?? []) {
    // ล้างก่อน กันรันซ้ำ
    await db.from("conversations").update({ ai_due_at: null }).eq("id", c.id);

    const { data: last } = await db.from("messages").select("direction")
      .eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(1).single();
    if (!last || last.direction === "out") continue; // มีคนตอบไปแล้ว

    const s = await generateSuggestions(c.id);
    if (await tryAutoSend(c.id, s.options, s.needs_human, s.id)) sent++;
  }
  return { checked: due?.length ?? 0, sent };
}
