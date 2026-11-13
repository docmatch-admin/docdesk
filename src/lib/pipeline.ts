import { embed } from "./ai";
import { logSystemError } from "./health";
import { maskForLearning, saveConfirmedBooking } from "./booking-store";
import { sendFileToChannel, sendImageToChannel, sendToChannel } from "./channels";
import { AUTO_CLOSE_EXEMPT_TAGS, CLEARED_ON_REOPEN_TAG, CLOSE_PATCH, DEFAULT_AUTO_CLOSE_HOURS, normalizeAutoCloseHours } from "./case-flow";
import { lineMarkAsRead } from "./channels/line";
import { classifyMetaEcho, metaMarkSeen, metaMessagingType, type MetaEcho } from "./channels/meta";
import { claimReplyTokenWithAge } from "./channels/reply-token";
import { getSetting, isWithinBusinessHours, resolveAiMode, type BusinessHours } from "./mode";
import { platformMayWriteDisplayName } from "./patient-name";
import { scrubPII } from "./pii";
import { matchSensitive, SENSITIVE_ACK_TEXT } from "./sensitive-rules";
import { loadSensitiveKeywords, markConversationSensitive, notifySensitiveChat } from "./sensitive-store";
import { markConversationReadWith } from "./read-receipts";
import { awardStarPoints, recordStaffResponse } from "./score-store";
import { classifyAck, classifyClosingMessage, endsConversation, hasUrgentSignal, isConversationTurn, isCustomerText, isStaffQuestion, isThanksOrSticker, shouldSkipSuggestion } from "./suggest-rules";
import { matchTagRules, type TagRule } from "./tags";
import { buildOutMediaUrl } from "./media-url";
import { CHAT_BUCKET, consumeUploadAny, downloadFile, loadRetentionDays, QUICK_BUCKET, removeFiles, storeImage, type StoredFile, type StoredMedia } from "./media-store";
import { FILE_LINK_DAYS, formatFileSize, MAX_FILE_BYTES } from "./files";
import { MAX_IMAGE_BYTES } from "./media";
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
  markAsReadToken?: string;
  skipAi?: boolean;             // เกินเพดาน AI: เก็บข้อความโดยไม่แปล
  isImage?: boolean;            // รูปภาพ: text เป็น caption ได้ ว่างได้
  media?: StoredMedia;          // มีเมื่อรูปถูกเก็บแล้ว ถ้าไม่มี = รอดาวน์โหลดใน after()
  /** ไฟล์ PDF: stored มีเมื่อเก็บแล้ว (เว็บ) ถ้าไม่มี = รอดาวน์โหลดใน after() */
  file?: { name: string; size?: number | null; stored?: StoredFile };
}

/** บันทึกข้อความเข้า แล้วคืน conversationId (เร็ว ใช้ก่อนตอบ webhook) */
export async function storeIncoming(input: IncomingInput) {
  const db = supabaseAdmin();

  const { data: channel, error: chErr } = await db
    .from("channels").select("id, type, ai_mode").eq("type", input.channelType).eq("enabled", true)
    .order("created_at").limit(1).single();
  if (chErr || !channel) throw new Error(`ไม่พบช่องทาง ${input.channelType} ที่เปิดใช้งาน`);

  const contactPatch: Record<string, unknown> = { channel_id: channel.id, external_id: input.externalId };
  if (input.displayName) {
    // ชื่อจากแพลตฟอร์มเก็บไว้เสมอ (แสดงเป็นบรรทัดเล็ก ค้นหาได้) แต่ไม่ทับชื่อที่เจ้าหน้าที่หรือ AI ตั้ง
    contactPatch.platform_name = input.displayName;
    const { data: existing } = await db.from("contacts").select("name_locked, name_source")
      .eq("channel_id", channel.id).eq("external_id", input.externalId).maybeSingle();
    if (platformMayWriteDisplayName(existing)) contactPatch.display_name = input.displayName;
  }
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
    .select("id, unread_count, status, sensitive, waiting_since, archived, tags, needs_human, booking_pending, open_tasks").single();
  if (cvErr || !conv) throw cvErr ?? new Error("conversation upsert failed");
  const wasClosed = conv.status === "closed";
  // ลูกค้าตอบรับ ขอบคุณ หรือบอกลา หลังเราตอบแล้ว: ไม่ต้องตอบต่อ
  const closingKind = conv.archived ? null : classifyClosingMessage(input.text, input.isImage);
  let endsChat = false;
  if (closingKind) {
    // ข้อความล่าสุดของการคุย นับข้อความที่ระบบนัดส่งด้วย (ลูกค้าตอบ "โอเค ขอบคุณ" หลังได้ข้อความนัด)
    const { data: recent } = await db.from("messages").select("direction, body, body_th, sender_type, imported_sender_name")
      .eq("conversation_id", conv.id).order("created_at", { ascending: false }).limit(10);
    const last = ((recent ?? []) as { direction: string; body: string | null; body_th: string | null; sender_type: string; imported_sender_name: string | null }[])
      .find(isConversationTurn);
    endsChat = endsConversation(closingKind, last ? { direction: last.direction, text: last.body_th || last.body || "" } : null);
  }
  // แชทที่เสร็จแล้วกลับมารอตอบทุกข้อความ ยกเว้นคำขอบคุณ สติกเกอร์ หรือข้อความจบการคุย
  const stayClosed = wasClosed && !conv.archived && (isThanksOrSticker(input.text, input.isImage) || endsChat);
  // แชทที่เปิดอยู่ปิดเลย ยกเว้นงานค้าง (รอลงนัด, ต้องให้คนตอบ, งานของทีม, แท็กตามต่อ/รอนัด) เหมือนการย้ายอัตโนมัติ
  const closeNow = !wasClosed && endsChat && !conv.booking_pending && !conv.needs_human && !((conv.open_tasks ?? 0) > 0)
    && !((conv.tags ?? []) as string[]).some((t) => AUTO_CLOSE_EXEMPT_TAGS.includes(t));
  // ตอบรับแต่ยังมีงานค้าง (รอลงนัด ต้องให้คนตอบ งานของทีม แท็กตามต่อ/รอนัด): แชทยังเปิดพร้อมป้ายงานค้าง
  // แต่ลูกค้าไม่ได้รอคำตอบ → ไม่อยู่ในรอตอบเพราะข้อความนี้ และไม่นับเวลารอ
  const ackOnly = !wasClosed && endsChat && !closeNow;

  // รูปหรือไฟล์ล้วน: AI อ่านไม่ได้ ไม่ต้องแปล และให้คนดู
  const imageOnly = (!!input.isImage || !!input.file) && !input.text.trim();
  const { language, th } = input.skipAi || imageOnly
    ? { language: contact.language as string, th: null }
    : await toThaiOrKeep(input.text, contact.language as string);

  const { data: msg, error: mErr } = await db.from("messages").insert({
    conversation_id: conv.id,
    direction: "in",
    sender_type: "customer",
    body: input.text,
    body_th: th,
    language,
    external_id: input.externalMessageId ?? null,
    line_mark_as_read_token: input.markAsReadToken ?? null,
    ...(input.isImage ? {
      media_type: "image",
      media_path: input.media?.path ?? null,
      media_preview_path: input.media?.previewPath ?? null,
      media_width: input.media?.width ?? null,
      media_height: input.media?.height ?? null,
    } : {}),
    ...(input.file ? {
      media_type: "file",
      media_path: input.file.stored?.path ?? null,
      file_name: input.file.stored?.name ?? input.file.name,
      file_size: input.file.stored?.size ?? input.file.size ?? null,
    } : {}),
  }).select("id").single();
  if (mErr || !msg) throw mErr ?? new Error("message insert failed");

  await Promise.all([
    db.from("contacts").update({ language }).eq("id", contact.id),
    db.from("conversations").update({
      ...(stayClosed ? {} : closeNow ? CLOSE_PATCH : { status: "open" }),
      ...(ackOnly ? { last_direction: "out", waiting_since: null } : {}),
      // แชทเก่าที่ได้ข้อความจริงจาก webhook คือแชทปกติแล้ว ต้องพิมพ์ตอบได้
      ...(conv.archived ? { archived: false } : {}),
      unread_count: (conv.unread_count ?? 0) + 1,
      last_message_at: new Date().toISOString(),
      last_message_preview: preview(th ?? input.text) || (input.file ? preview(`[ไฟล์] ${input.file.name}`) : "[รูปภาพ]"),
      ...(imageOnly ? { needs_human: true } : {}), // AI ไม่เห็นรูป ต้องให้คนดู
      ...(input.replyToken
        ? { line_reply_token: input.replyToken, line_reply_token_at: new Date().toISOString() }
        : {}),
    }).eq("id", conv.id),
  ]);

  // ลูกค้าทักกลับมาหลังปิดเคส: การนัดเดิมอาจจบไปแล้ว ถ้าแชทยังเปิดอยู่ไม่แตะ เพราะเจ้าหน้าที่อาจเพิ่งติดเอง
  if (wasClosed && !stayClosed) {
    await setConversationTag(conv.id as string, CLEARED_ON_REOPEN_TAG, "remove", "rule")
      .catch((e) => console.error("clear tag on reopen failed", e));
  }

  await applySensitiveRules(conv.id as string, [input.text, th ?? ""].join("\n"), !!conv.sensitive, !!conv.waiting_since);

  if (isCustomerText(input.text)) {
    // เกินเพดาน AI ไม่ได้ตรวจภาษาของข้อความนี้ language เป็นค่าเดิมของรายชื่อ จึงไม่นำมานับ
    await applyTagRules(conv.id as string, [input.text, th ?? ""].join("\n"), input.skipAi ? "th" : language);
  }

  return { conversationId: conv.id as string, messageId: msg.id as string, duplicate: false };
}

/**
 * แปลข้อความลูกค้า ถ้า AI ล้ม (เช่น OpenAI ไม่รับพารามิเตอร์ของโมเดลใหม่) เก็บข้อความต้นฉบับไว้ก่อน
 * ไม่ throw เพราะจะทำให้ webhook ล้มและข้อความลูกค้าไม่เข้า inbox
 */
async function toThaiOrKeep(text: string, fallbackLanguage: string): Promise<{ language: string; th: string | null }> {
  try {
    return await toThai(text);
  } catch (e) {
    console.error("translate failed", e instanceof Error ? e.message : e);
    await logSystemError("ai:translate", e).catch(() => {});
    return { language: fallbackLanguage || "th", th: null };
  }
}

/** แชทลับ: ติดจากคำสำคัญ ต้องให้คนตอบเสมอ และแจ้งเฉพาะคนมีสิทธิ์เมื่อเริ่มชุดข้อความใหม่ พลาดต้องไม่ทำให้ข้อความลูกค้าหาย */
async function applySensitiveRules(conversationId: string, text: string, wasSensitive: boolean, wasWaiting: boolean) {
  try {
    const justMarked = !wasSensitive && matchSensitive(text, await loadSensitiveKeywords())
      && (await markConversationSensitive(conversationId, "คำสำคัญ"));
    if (wasSensitive) await supabaseAdmin().from("conversations").update({ needs_human: true }).eq("id", conversationId);
    if (justMarked || (wasSensitive && !wasWaiting)) await notifySensitiveChat();
  } catch (e) {
    console.error("sensitive rules failed", e);
  }
}

/** กฎคำสำคัญ: ไม่ใช้ AI ทำงานทุกโหมด แท็กพลาดต้องไม่ทำให้ข้อความลูกค้าหาย */
async function applyTagRules(conversationId: string, text: string, language: string) {
  try {
    const db = supabaseAdmin();
    const [{ data: rules }, { data: tags }] = await Promise.all([
      db.from("tag_rules").select("kind, keyword, exclude_keywords, tag"),
      db.from("tags").select("name").eq("active", true),
    ]);
    const names = (tags ?? []).map((t) => t.name as string);
    const foreign = language === "th" ? 0 : await countForeignMessages(conversationId);
    for (const tag of matchTagRules(text, foreign, (rules ?? []) as TagRule[], names)) {
      await setConversationTag(conversationId, tag, "add", "rule");
    }
  } catch (e) {
    console.error("tag rules failed", e);
  }
}

/** ข้อความของลูกค้าที่ toThai ตรวจว่าไม่ใช่ภาษาไทย ไม่นับรูป และคำสั้นอย่าง "ok" หรือ "thanks" ที่คนไทยก็พิมพ์ */
async function countForeignMessages(conversationId: string) {
  const { data } = await supabaseAdmin().from("messages").select("body")
    .eq("conversation_id", conversationId).eq("direction", "in").neq("language", "th")
    .order("created_at", { ascending: false }).limit(20);
  return (data ?? []).filter((m) => isCustomerText(m.body as string) && !classifyAck(m.body as string)).length;
}

export async function setConversationTag(conversationId: string, tag: string, action: "add" | "remove", by: "staff" | "ai" | "rule") {
  const { data, error } = await supabaseAdmin().rpc("set_conversation_tag", {
    p_conversation: conversationId, p_tag: tag, p_action: action, p_by: by,
  });
  if (error) throw error;
  return (data ?? []) as string[];
}

/** auto/fallback: รอให้ลูกค้าพิมพ์จบก่อน ข้อความใหม่จะเริ่มนับใหม่ และร่างครั้งเดียวจากทั้งชุด */
export const aiTiming = { debounceMs: 8_000 };

/** หลังบันทึก: ตัดสินใจตามโหมด AI (เรียกใน after()) */
export async function processIncoming(conversationId: string, messageId: string, replyToken?: string) {
  const db = supabaseAdmin();
  const { data: conv } = await db
    .from("conversations").select("id, ai_mode, sensitive, status, channels(ai_mode)").eq("id", conversationId).single();
  if (!conv) return;
  // ยังปิดอยู่ = ลูกค้าแค่ตอบรับหรือบอกลา ไม่ต้องร่างหรือตอบ
  if (conv.status === "closed") return;

  const channel = (Array.isArray(conv.channels) ? conv.channels[0] : conv.channels) as { ai_mode: AiMode | null };
  const mode = await resolveAiMode(conv as { ai_mode: AiMode | null }, channel ?? { ai_mode: null });

  // ไม่ร่างตอนข้อความเข้า ประหยัด LLM: ร่างและติดแท็กตอนเจ้าหน้าที่เปิดแชท แต่เรื่องด่วนยังต้องขึ้นป้ายในรายการแชท
  if (mode === "off" || mode === "assist") {
    const { data: m } = await db.from("messages").select("body, body_th").eq("id", messageId).maybeSingle();
    if (m && hasUrgentSignal(m.body_th || m.body)) {
      await db.from("conversations").update({ needs_human: true }).eq("id", conversationId);
    }
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, aiTiming.debounceMs));
  const { data: recent } = await db.from("messages").select("id, body")
    .eq("conversation_id", conversationId).eq("direction", "in")
    .order("created_at", { ascending: false }).limit(20);
  const latest = (recent ?? []).find((m) => isCustomerText(m.body as string));
  if (latest?.id !== messageId) return; // มีข้อความใหม่กว่า ให้รอบของข้อความนั้นทำแทน

  // แชทลับตอบรับด้วยเทมเพลต ไม่ต้องเรียก LLM คำแนะนำสร้างตอนเจ้าหน้าที่เปิดแชท
  const suggestion = conv.sensitive
    ? { id: null, options: [], needs_human: true, suggested_tags: [] as string[], skipped: undefined }
    : await generateSuggestions(conversationId);
  if (suggestion.skipped) return;

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
  const { data: conv } = await supabaseAdmin().from("conversations").select("sensitive").eq("id", conversationId).maybeSingle();
  if (conv?.sensitive) return sendSensitiveAck(conversationId, replyToken);

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
  // แจ้งว่าอ่านแล้วหลังส่งสำเร็จเท่านั้น ลูกค้าจะได้ไม่เห็นว่าอ่านแล้วแต่ไม่มีคำตอบ
  await markConversationRead(conversationId);
  return true;
}

/**
 * แชทลับ AI ส่งได้แค่ข้อความตอบรับ ส่งซ้ำไม่ได้จนกว่าเจ้าหน้าที่จะตอบ
 * ลูกค้าส่งหลายรอบระหว่างรอจะได้ไม่เห็นข้อความเดิมซ้ำ
 */
async function sendSensitiveAck(conversationId: string, replyToken?: string): Promise<boolean> {
  const db = supabaseAdmin();
  await db.from("conversations").update({ needs_human: true, ai_due_at: null }).eq("id", conversationId);
  const { data: rows } = await db.from("messages").select("direction, sender_type, body, body_th")
    .eq("conversation_id", conversationId).neq("imported", true).neq("sender_type", "system").order("created_at", { ascending: false }).limit(50);
  const recent = (rows ?? []) as { direction: string; sender_type: string; body: string; body_th: string | null }[];
  const lastOut = recent.find((m) => m.direction === "out");
  if (lastOut?.sender_type === "ai") return false;
  const pending: string[] = [];
  for (const m of recent) {
    if (m.direction === "out") break;
    pending.unshift(m.body_th || m.body);
  }
  if (!pending.length || shouldSkipSuggestion(pending.join("\n"), lastOut ? lastOut.body_th || lastOut.body : null)) return false;
  try {
    await sendReply({ conversationId, textTh: SENSITIVE_ACK_TEXT, senderType: "ai", replyToken });
  } catch (e) {
    console.error("sensitive ack failed", e);
    return false;
  }
  await markConversationRead(conversationId);
  return true;
}

/** แจ้งแพลตฟอร์มว่าคลินิกอ่านแล้ว ห้ามเรียกตอนแค่สร้างคำแนะนำ */
export function markConversationRead(conversationId: string) {
  return markConversationReadWith(supabaseAdmin(), conversationId, { line: lineMarkAsRead, meta: metaMarkSeen });
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
  skipLearn?: boolean;          // ข้อความเฉพาะนัดนี้ ไม่นำไปเป็นตัวอย่างคำตอบ
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

  const isMeta = channel.type === "facebook" || channel.type === "instagram";
  let lastInboundAt: Date | null = null;
  if (isMeta) {
    const { data: lastIn } = await db.from("messages").select("created_at")
      .eq("conversation_id", input.conversationId).eq("direction", "in")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    lastInboundAt = lastIn ? new Date(lastIn.created_at as string) : null;
  }
  const claimed = channel.type === "line" ? await claimReplyTokenWithAge(db, input.conversationId) : undefined;
  // watermark ของ Meta คือเวลาที่ Meta ได้รับข้อความ ถ้าใช้เวลาหลังส่งเสร็จ ข้อความล่าสุดจะดูเหมือนส่งหลัง watermark และไม่ขึ้นว่าอ่านแล้ว
  const sentAt = new Date().toISOString();
  const mids = await sendToChannel(channel.type, contact.external_id, body, {
    replyToken: claimed?.token, lastInboundAt, senderType: input.senderType,
    lineMeta: { kind: "chat", conversationId: input.conversationId, tokenAgeMs: claimed?.ageMs ?? null },
  });

  const { data: msg } = await db.from("messages").insert({
    conversation_id: input.conversationId,
    direction: "out",
    sender_type: input.senderType,
    sender_id: input.senderId ?? null,
    body,
    body_th: language === "th" ? null : input.textTh,
    language,
    // echo ของข้อความนี้จะถูกข้ามเพราะ mid ตรงกัน
    ...(isMeta ? { created_at: sentAt, external_id: mids?.[0] ?? null } : {}),
  }).select("id, created_at").single();

  await db.from("conversations").update({
    unread_count: 0,
    ai_due_at: null,
    // เจ้าหน้าที่ถามลูกค้าในแชทที่เสร็จแล้ว: กลับมาอยู่ในทั้งหมด (ไม่เข้ารอตอบ ลูกค้าเงียบนานจะถูกย้ายกลับเอง) ตอบรับเฉยๆ อยู่ที่เดิม
    ...(input.senderType === "staff" ? { needs_human: false, ...(isStaffQuestion(input.textTh) ? { status: "open" } : {}) } : {}),
    last_message_at: new Date().toISOString(),
    last_message_preview: preview(input.textTh),
  }).eq("id", input.conversationId);

  if (input.suggestionId != null && input.chosenIndex != null) {
    await applyChosenBooking(input.conversationId, input.suggestionId, input.chosenIndex, msg?.id ?? null);
  }

  if (input.senderType === "staff") {
    if (input.senderId) {
      await claimIfUnassigned(input.conversationId, input.senderId);
      await recordStaffResponse({
        conversationId: input.conversationId,
        replyId: msg?.id ?? null,
        staffId: input.senderId,
        replyText: input.textTh,
        repliedAt: (msg?.created_at as string | undefined) ?? new Date().toISOString(),
      });
    }
    if (!input.skipLearn) await learnFromStaffReply(input, msg?.id ?? null).catch((e) => console.error("learn failed", e));
  } else if (input.suggestionId != null && input.chosenIndex != null) {
    await db.from("suggestions").update({ chosen_index: input.chosenIndex, edited: false }).eq("id", input.suggestionId);
  }

  return { messageId: msg?.id ?? null, body };
}

/** ส่งข้อความจองแล้ว: ลูกค้าได้คำยืนยันไปแล้ว ถ้าบันทึกนัดพลาดต้องให้คนตามต่อ ห้ามทำให้การส่งล้ม */
async function applyChosenBooking(conversationId: string, suggestionId: string, chosenIndex: number, messageId: string | null) {
  const db = supabaseAdmin();
  const { data } = await db.from("suggestions").select("options").eq("id", suggestionId).maybeSingle();
  const booking = ((data?.options ?? []) as SuggestionOption[])[chosenIndex]?.booking;
  if (!booking) return;
  if (booking.action === "unknown_service") {
    await db.from("conversations").update({ needs_human: true }).eq("id", conversationId);
  }
  if (booking.action !== "confirm") return;
  try {
    await saveConfirmedBooking(conversationId, booking, messageId);
  } catch (e) {
    console.error("save booking failed", e);
    await db.from("conversations").update({ needs_human: true }).eq("id", conversationId);
  }
}

/** เจ้าหน้าที่ตอบแชทที่ยังไม่มีผู้ดูแล: เป็นผู้ดูแลอัตโนมัติ พลาดแล้วต้องไม่ทำให้การส่งข้อความล้ม */
async function claimIfUnassigned(conversationId: string, staffId: string) {
  const { error } = await supabaseAdmin().rpc("assign_if_unassigned", { p_conversation: conversationId, p_to: staffId });
  if (error) console.error("auto assign failed", error);
}

export interface MediaReplyInput {
  conversationId: string;
  uploadPath?: string;          // ไฟล์ที่เจ้าหน้าที่อัปโหลดเข้า uploads/
  quickMediaId?: string;
  captionTh?: string;
  senderId: string;
  skipTranslate?: boolean;
  origin: string;               // โดเมนของแอป ใช้สร้าง URL ที่ LINE/Meta ดึงรูป
  fileName?: string;            // ชื่อไฟล์จากเครื่องเจ้าหน้าที่ ใช้เมื่อไฟล์ที่อัปโหลดเป็น PDF
}

/** เจ้าหน้าที่ส่งรูป: ไม่เข้าระบบเรียนรู้คำตอบ */
export async function sendMediaReply(input: MediaReplyInput) {
  const db = supabaseAdmin();
  const { data: conv, error } = await db
    .from("conversations")
    .select("id, contacts(external_id, language), channels(type)")
    .eq("id", input.conversationId).single();
  if (error || !conv) throw error ?? new Error("conversation not found");
  const contact = (Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts) as { external_id: string; language: string };
  const channel = (Array.isArray(conv.channels) ? conv.channels[0] : conv.channels) as { type: ChannelType };

  // ตรวจกติกา 24 ชม. ก่อนเริ่มบีบอัดและเก็บไฟล์
  const isMeta = channel.type === "facebook" || channel.type === "instagram";
  let lastInboundAt: Date | null = null;
  if (isMeta) {
    const { data: lastIn } = await db.from("messages").select("created_at")
      .eq("conversation_id", input.conversationId).eq("direction", "in")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    lastInboundAt = lastIn ? new Date(lastIn.created_at as string) : null;
    metaMessagingType(lastInboundAt, "staff");
  }

  const captionTh = input.captionTh?.trim() ?? "";
  const language = input.skipTranslate ? "th" : contact.language || "th";
  const caption = captionTh && language !== "th" ? await fromThai(captionTh, language) : captionTh;

  // รูปใช้บ่อยคัดลอกเป็นไฟล์ของแชท ลบจากคลังภายหลังแล้วประวัติแชทไม่เสีย และระบบลบตามอายุไม่แตะคลัง
  let media: StoredMedia | null = null;
  let file: StoredFile | null = null;
  if (input.quickMediaId) {
    const { data: quick } = await db.from("quick_media").select("path, preview_path").eq("id", input.quickMediaId).maybeSingle();
    if (!quick) throw new Error("ไม่พบรูปที่ใช้บ่อยนี้");
    const { default: sharp } = await import("sharp");
    const main = await downloadFile(QUICK_BUCKET, quick.path as string);
    const meta = await sharp(main).metadata();
    media = await storeImage(CHAT_BUCKET, {
      main,
      preview: await downloadFile(QUICK_BUCKET, quick.preview_path as string),
      width: meta.width ?? 0,
      height: meta.height ?? 0,
    });
  } else if (input.uploadPath) {
    // ปุ่มแนบเดียวรับทั้งรูปและ PDF ชนิดตัดสินจากเนื้อไฟล์
    const up = await consumeUploadAny(input.uploadPath, CHAT_BUCKET, { maxImage: MAX_IMAGE_BYTES, maxFile: MAX_FILE_BYTES, fileName: input.fileName });
    if (up.kind === "image") media = up.media;
    else file = up.file;
  } else {
    throw new Error("ไม่มีรูปที่จะส่ง");
  }
  const storedPaths = file ? [file.path] : [media!.path, media!.previewPath];

  // ต้องมีแถวก่อนส่ง เพราะ Meta ดึงรูปและไฟล์ระหว่างที่เรายังรอคำตอบ
  const messageId = crypto.randomUUID();
  const { data: inserted } = await db.from("messages").insert({
    id: messageId,
    conversation_id: input.conversationId,
    direction: "out",
    sender_type: "staff",
    sender_id: input.senderId,
    body: caption,
    body_th: caption !== captionTh ? captionTh : null,
    language,
    ...(file
      ? { media_type: "file", media_path: file.path, file_name: file.name, file_size: file.size }
      : {
          media_type: "image",
          media_path: media!.path,
          media_preview_path: media!.previewPath,
          media_width: media!.width,
          media_height: media!.height,
        }),
  }).select("created_at").single();

  try {
    const claimed = channel.type === "line" ? await claimReplyTokenWithAge(db, input.conversationId) : undefined;
    const ttlDays = await loadRetentionDays();
    // รูป/ไฟล์ + ข้อความรวมเป็นคำขอเดียว (reply ครั้งเดียว)
    const opts = {
      replyToken: claimed?.token, lastInboundAt, senderType: "staff" as const,
      lineMeta: { kind: "chat" as const, conversationId: input.conversationId, tokenAgeMs: claimed?.ageMs ?? null },
    };
    const mids = file
      ? await sendFileToChannel(channel.type, contact.external_id, {
          // LINE: ลูกค้าได้ลิงก์ไปกดเปิดเอง จึงหมดอายุเร็ว Meta ดึงไฟล์ไปเก็บทันที ใช้อายุเท่ารูป
          url: buildOutMediaUrl(input.origin, messageId, "file", { ttlDays: channel.type === "line" ? FILE_LINK_DAYS : ttlDays, fileName: file.name }),
          name: file.name,
          sizeText: formatFileSize(file.size),
          expiresAt: new Date(Date.now() + FILE_LINK_DAYS * 86_400_000),
          language,
        }, caption, opts)
      : await sendImageToChannel(channel.type, contact.external_id, {
          main: buildOutMediaUrl(input.origin, messageId, "main", { ttlDays }),
          preview: buildOutMediaUrl(input.origin, messageId, "preview", { ttlDays }),
        }, caption, opts);
    if (mids?.[0]) await db.from("messages").update({ external_id: mids[0] }).eq("id", messageId);
  } catch (e) {
    await db.from("messages").delete().eq("id", messageId);
    await removeFiles(CHAT_BUCKET, storedPaths);
    throw e;
  }

  await db.from("conversations").update({
    unread_count: 0,
    ai_due_at: null,
    needs_human: false,
    ...(isStaffQuestion(captionTh) ? { status: "open" } : {}),
    last_message_at: new Date().toISOString(),
    last_message_preview: preview(`${file ? `[ไฟล์] ${file.name}` : "[รูปภาพ]"} ${captionTh}`),
  }).eq("id", input.conversationId);
  await claimIfUnassigned(input.conversationId, input.senderId);
  await recordStaffResponse({
    conversationId: input.conversationId,
    replyId: messageId,
    staffId: input.senderId,
    replyText: captionTh,
    repliedAt: (inserted?.created_at as string | undefined) ?? new Date().toISOString(),
  });

  return { messageId };
}

// ---------------------------------------------------------------------------
// เรียนรู้: เก็บ "คำถาม → คำตอบเจ้าหน้าที่" + log ว่าเลือก/แก้คำแนะนำไหม
// ---------------------------------------------------------------------------
async function learnFromStaffReply(input: ReplyInput, messageId: string | null) {
  const db = supabaseAdmin();
  let chosen: SuggestionOption | null = null;
  const { data: convFlag } = await db.from("conversations").select("sensitive").eq("id", input.conversationId).maybeSingle();
  const sensitive = !!convFlag?.sensitive;

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
    // วันเวลาเฉพาะนัดนี้ ไม่ใช่สำนวนที่ควรเรียนรู้
    if (chosen?.booking) return;
  }
  // แชทลับไม่นำไปเรียนรู้
  if (sensitive) return;

  // คำถามลูกค้าก่อนหน้าข้อความที่เพิ่งส่ง
  const { data: rows } = await db.from("messages")
    .select("id, direction, sender_type, body, body_th, created_at")
    .eq("conversation_id", input.conversationId).neq("imported", true).neq("sender_type", "system")
    .order("created_at", { ascending: false }).limit(15);
  const msgs = (rows ?? []).reverse().filter((m) => m.id !== messageId);
  const { text: question } = pendingCustomerText(msgs as never);

  const q = scrubPII(await maskForLearning(input.conversationId, question)).trim();
  const a = scrubPII(await maskForLearning(input.conversationId, input.textTh)).trim();
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

// ---------------------------------------------------------------------------
// echo จาก Meta: ข้อความที่เพจส่งนอก DocDesk
// ---------------------------------------------------------------------------
export const META_ECHO_STAFF_NAME = "Meta Business Suite";
export const META_ECHO_AUTO_NAME = "ตอบกลับอัตโนมัติของเพจ";

/** จด app_id ที่เห็นใน echo ใช้ตั้ง meta_auto_reply_app_ids เพราะ Meta ไม่ได้ระบุ id ของข้อความอัตโนมัติไว้ชัด */
async function noteEchoApp(appId: string | null, kind: string, at: string) {
  const seen = await getSetting<Record<string, { kind: string; count: number; last_at: string }>>("meta_echo_app_ids", {});
  const key = appId ?? "none";
  seen[key] = { kind, count: (seen[key]?.count ?? 0) + 1, last_at: at };
  await supabaseAdmin().from("settings").upsert({ key: "meta_echo_app_ids", value: seen }, { onConflict: "key" });
}

/**
 * echo ของเพจ:
 * - DocDesk ส่งเอง: ข้าม (mid ตรง หรือ app_id เป็นแอป DocDesk)
 * - คนตอบใน Meta Business Suite: ข้อความขาออกของเจ้าหน้าที่ ออกจากรอตอบ ไม่คิดคะแนน และเรียนรู้ยกเว้นแชทลับ
 * - ข้อความอัตโนมัติ: ข้อความระบบ แชทยังรอตอบ
 */
export async function storeMetaEcho(echo: MetaEcho, displayName?: string): Promise<{ stored: "staff" | "auto" | null }> {
  const db = supabaseAdmin();
  const receivedAt = new Date().toISOString();
  const kind = classifyMetaEcho(echo, await getSetting<string[]>("meta_auto_reply_app_ids", []));
  await noteEchoApp(echo.appId, kind, receivedAt).catch((e) => console.error("note echo app failed", e));
  if (kind === "own") return { stored: null };
  const { data: dup } = await db.from("messages").select("id").eq("external_id", echo.messageId).maybeSingle();
  if (dup) return { stored: null };

  const { data: channel } = await db.from("channels").select("id").eq("type", echo.kind).eq("enabled", true)
    .order("created_at").limit(1).maybeSingle();
  if (!channel) throw new Error(`ไม่พบช่องทาง ${echo.kind} ที่เปิดใช้งาน`);
  // ไม่ upsert ชื่อ เพราะจะทับชื่อจริงของลูกค้าเดิม
  let { data: contact } = await db.from("contacts").select("id, language")
    .eq("channel_id", channel.id).eq("external_id", echo.customerId).maybeSingle();
  if (!contact) {
    const { data, error } = await db.from("contacts").insert({ channel_id: channel.id, external_id: echo.customerId, display_name: displayName ?? null, platform_name: displayName ?? null })
      .select("id, language").single();
    if (error || !data) throw error ?? new Error("contact insert failed");
    contact = data;
  }
  const { data: conv, error: cvErr } = await db.from("conversations")
    .upsert({ contact_id: contact.id, channel_id: channel.id }, { onConflict: "contact_id" })
    .select("id").single();
  if (cvErr || !conv) throw cvErr ?? new Error("conversation upsert failed");

  const { data: msg, error } = await db.from("messages").insert({
    conversation_id: conv.id,
    direction: "out",
    sender_type: kind === "auto" ? "system" : "staff",
    sender_id: null,
    body: echo.text,
    language: (contact.language as string | null) || "th",
    external_id: echo.messageId,
    imported_sender_name: kind === "auto" ? META_ECHO_AUTO_NAME : META_ECHO_STAFF_NAME,
    // ใช้เวลาที่รับ เหมือนข้อความเข้า เวลาจาก Meta คลาดกับเวลาที่เราบันทึกข้อความลูกค้า คำตอบอาจเรียงก่อนคำถาม
    created_at: receivedAt,
  }).select("id").single();
  // Meta ส่ง echo ซ้ำพร้อมกันได้ ชนกันแปลว่าบันทึกไปแล้ว
  if (error) {
    if (error.code === "23505") return { stored: null };
    throw error;
  }
  if (kind === "auto") return { stored: "auto" };

  await db.from("conversations").update({
    unread_count: 0,
    ai_due_at: null,
    needs_human: false,
    // ถามจาก Meta Business Suite ในแชทที่เสร็จแล้ว: กลับมาอยู่ในทั้งหมดเหมือนถามจาก DocDesk
    ...(isStaffQuestion(echo.text) ? { status: "open" } : {}),
    last_message_at: receivedAt,
    last_message_preview: preview(echo.text),
  }).eq("id", conv.id);
  // ไม่มีเจ้าหน้าที่ใน DocDesk ให้ผูก จึงไม่คิดคะแนน learnFromStaffReply ข้ามแชทลับเอง
  if (!/^\[ส่ง.*จากเพจ\]$/.test(echo.text)) {
    await learnFromStaffReply({ conversationId: conv.id as string, textTh: echo.text, senderType: "staff" }, msg?.id ?? null)
      .catch((e) => console.error("learn failed", e));
  }
  return { stored: "staff" };
}

/** กดดาว: บันทึกข้อความนี้เป็นคำตอบมาตรฐาน */
export async function starMessage(messageId: string, staffId: string) {
  const db = supabaseAdmin();
  const { data: m } = await db.from("messages")
    .select("id, conversation_id, direction, body, body_th, created_at, sender_id, sender_type, starred").eq("id", messageId).single();
  if (!m || m.direction !== "out") throw new Error("กดดาวได้เฉพาะข้อความที่คลินิกตอบ");

  const firstStar = !m.starred;
  await db.from("messages").update({ starred: true }).eq("id", messageId);
  if (firstStar) {
    await awardStarPoints({
      id: m.id as string,
      conversation_id: m.conversation_id as string,
      sender_id: (m.sender_id as string | null) ?? null,
      sender_type: m.sender_type as string,
    }, staffId);
  }

  // แชทลับกดดาวได้ตามปกติ แต่ไม่เป็นตัวอย่างคำตอบ
  const { data: convFlag } = await db.from("conversations").select("sensitive").eq("id", m.conversation_id as string).maybeSingle();
  if (convFlag?.sensitive) return;

  const { data: existing } = await db.from("reply_examples").select("id").eq("source_message_id", messageId).maybeSingle();
  if (existing) {
    await db.from("reply_examples").update({ starred: true, active: true }).eq("id", existing.id);
    return;
  }

  const { data: before } = await db.from("messages")
    .select("id, direction, sender_type, body, body_th, created_at")
    .eq("conversation_id", m.conversation_id).neq("imported", true).lt("created_at", m.created_at)
    .order("created_at", { ascending: false }).limit(10);
  const { text: question } = pendingCustomerText((before ?? []).reverse() as never);
  const conversationId = m.conversation_id as string;
  const q = scrubPII(await maskForLearning(conversationId, question)).trim() || "(ไม่มีคำถาม)";
  const a = scrubPII(await maskForLearning(conversationId, (m.body_th || m.body) as string)).trim();
  await db.from("reply_examples").insert({
    question: q, answer: a, starred: true, source_message_id: messageId, created_by: staffId,
    embedding: JSON.stringify(await embed(q)),
  });
}

/**
 * เราตอบล่าสุดและลูกค้าเงียบเกินกำหนด: ย้ายไปเสร็จแล้ว เรียกทุกนาทีจาก cron
 * อัปเดตคำสั่งเดียวพร้อมเงื่อนไข ลูกค้าที่เพิ่งทักเข้ามาจะได้ไม่ถูกปิด
 * ยกเว้น needs_human ด้วย เพราะเป็นเรื่องที่ยังต้องให้คนดู
 */
export async function autoCloseQuietChats(now = Date.now()) {
  const db = supabaseAdmin();
  const hours = normalizeAutoCloseHours(await getSetting<unknown>("auto_close_hours", DEFAULT_AUTO_CLOSE_HOURS));
  if (hours === 0) return 0;
  const cutoff = new Date(now - hours * 3_600_000).toISOString();
  const { data, error } = await db.from("conversations").update(CLOSE_PATCH)
    .eq("status", "open").eq("last_direction", "out").eq("needs_human", false).neq("booking_pending", true)
    // งานของทีมยังไม่ครบ: รอให้เจ้าหน้าที่ติ๊กก่อน
    .lt("open_tasks", 1)
    .lt("last_message_at", cutoff)
    .or(`reopened_at.is.null,reopened_at.lt.${cutoff}`)
    .not("tags", "ov", `{${AUTO_CLOSE_EXEMPT_TAGS.join(",")}}`)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
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

    // ข้อความอัตโนมัติของเพจไม่ใช่การตอบ
    const { data: last } = await db.from("messages").select("direction")
      .eq("conversation_id", c.id).neq("sender_type", "system").order("created_at", { ascending: false }).limit(1).single();
    if (!last || last.direction === "out") continue; // มีคนตอบไปแล้ว

    const s = await generateSuggestions(c.id);
    if (s.skipped) continue;
    if (await tryAutoSend(c.id, s.options, s.needs_human, s.id)) sent++;
  }
  return { checked: due?.length ?? 0, sent };
}
