import { embed } from "./ai";
import { sendImageToChannel, sendToChannel } from "./channels";
import { lineMarkAsRead } from "./channels/line";
import { metaMarkSeen, metaMessagingType } from "./channels/meta";
import { claimReplyToken } from "./channels/reply-token";
import { getSetting, isWithinBusinessHours, resolveAiMode, type BusinessHours } from "./mode";
import { scrubPII } from "./pii";
import { markConversationReadWith } from "./read-receipts";
import { classifyAck, hasUrgentSignal, isCustomerText } from "./suggest-rules";
import { matchTagRules, type TagRule } from "./tags";
import { buildOutMediaUrl } from "./media-url";
import { CHAT_BUCKET, consumeUpload, downloadFile, loadRetentionDays, QUICK_BUCKET, removeFiles, storeImage, type StoredMedia } from "./media-store";
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

  const imageOnly = !!input.isImage && !input.text.trim();
  const { language, th } = input.skipAi || imageOnly
    ? { language: contact.language as string, th: null }
    : await toThai(input.text);

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
  }).select("id").single();
  if (mErr || !msg) throw mErr ?? new Error("message insert failed");

  await Promise.all([
    db.from("contacts").update({ language }).eq("id", contact.id),
    db.from("conversations").update({
      status: "open",
      unread_count: (conv.unread_count ?? 0) + 1,
      last_message_at: new Date().toISOString(),
      last_message_preview: preview(th ?? input.text) || "[รูปภาพ]",
      ...(imageOnly ? { needs_human: true } : {}), // AI ไม่เห็นรูป ต้องให้คนดู
      ...(input.replyToken
        ? { line_reply_token: input.replyToken, line_reply_token_at: new Date().toISOString() }
        : {}),
    }).eq("id", conv.id),
  ]);

  if (isCustomerText(input.text)) {
    // เกินเพดาน AI ไม่ได้ตรวจภาษาของข้อความนี้ language เป็นค่าเดิมของรายชื่อ จึงไม่นำมานับ
    await applyTagRules(conv.id as string, [input.text, th ?? ""].join("\n"), input.skipAi ? "th" : language);
  }

  return { conversationId: conv.id as string, messageId: msg.id as string, duplicate: false };
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

/** โหมด auto: ติดแท็กที่ AI เสนอเองเฉพาะกลุ่ม topic ไม่เรียก LLM เพิ่ม */
async function autoApplyTopicTags(conversationId: string, suggested: string[] = []) {
  if (!suggested.length) return;
  try {
    const { data: topics } = await supabaseAdmin().from("tags").select("name")
      .eq("group", "topic").eq("active", true).in("name", suggested);
    for (const t of topics ?? []) await setConversationTag(conversationId, t.name as string, "add", "ai");
  } catch (e) {
    console.error("auto tag failed", e);
  }
}

/** auto/fallback: รอให้ลูกค้าพิมพ์จบก่อน ข้อความใหม่จะเริ่มนับใหม่ และร่างครั้งเดียวจากทั้งชุด */
export const aiTiming = { debounceMs: 8_000 };

/** หลังบันทึก: ตัดสินใจตามโหมด AI (เรียกใน after()) */
export async function processIncoming(conversationId: string, messageId: string, replyToken?: string) {
  const db = supabaseAdmin();
  const { data: conv } = await db
    .from("conversations").select("id, ai_mode, channels(ai_mode)").eq("id", conversationId).single();
  if (!conv) return;

  const channel = (Array.isArray(conv.channels) ? conv.channels[0] : conv.channels) as { ai_mode: AiMode | null };
  const mode = await resolveAiMode(conv as { ai_mode: AiMode | null }, channel ?? { ai_mode: null });

  // ไม่ร่างตอนข้อความเข้า สร้างตอนเจ้าหน้าที่เปิดแชท แต่เรื่องด่วนยังต้องขึ้นป้ายในรายการแชท
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

  const suggestion = await generateSuggestions(conversationId);
  if (suggestion.skipped) return;

  if (mode === "auto") await autoApplyTopicTags(conversationId, suggestion.suggested_tags);

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
  // แจ้งว่าอ่านแล้วหลังส่งสำเร็จเท่านั้น ลูกค้าจะได้ไม่เห็นว่าอ่านแล้วแต่ไม่มีคำตอบ
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
  const replyToken = channel.type === "line" ? await claimReplyToken(db, input.conversationId) : undefined;
  // watermark ของ Meta คือเวลาที่ Meta ได้รับข้อความ ถ้าใช้เวลาหลังส่งเสร็จ ข้อความล่าสุดจะดูเหมือนส่งหลัง watermark และไม่ขึ้นว่าอ่านแล้ว
  const sentAt = new Date().toISOString();
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
    ...(isMeta ? { created_at: sentAt } : {}),
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

export interface MediaReplyInput {
  conversationId: string;
  uploadPath?: string;          // ไฟล์ที่เจ้าหน้าที่อัปโหลดเข้า uploads/
  quickMediaId?: string;
  captionTh?: string;
  senderId: string;
  skipTranslate?: boolean;
  origin: string;               // โดเมนของแอป ใช้สร้าง URL ที่ LINE/Meta ดึงรูป
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
  let media: StoredMedia;
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
    media = await consumeUpload(input.uploadPath, CHAT_BUCKET, MAX_IMAGE_BYTES);
  } else {
    throw new Error("ไม่มีรูปที่จะส่ง");
  }

  // ต้องมีแถวก่อนส่ง เพราะ Meta ดึงรูประหว่างที่เรายังรอคำตอบ
  const messageId = crypto.randomUUID();
  await db.from("messages").insert({
    id: messageId,
    conversation_id: input.conversationId,
    direction: "out",
    sender_type: "staff",
    sender_id: input.senderId,
    body: caption,
    body_th: caption !== captionTh ? captionTh : null,
    language,
    media_type: "image",
    media_path: media.path,
    media_preview_path: media.previewPath,
    media_width: media.width,
    media_height: media.height,
  });

  try {
    const replyToken = channel.type === "line" ? await claimReplyToken(db, input.conversationId) : undefined;
    const ttlDays = await loadRetentionDays();
    await sendImageToChannel(channel.type, contact.external_id, {
      main: buildOutMediaUrl(input.origin, messageId, "main", { ttlDays }),
      preview: buildOutMediaUrl(input.origin, messageId, "preview", { ttlDays }),
    }, caption, { replyToken, lastInboundAt, senderType: "staff" });
  } catch (e) {
    await db.from("messages").delete().eq("id", messageId);
    await removeFiles(CHAT_BUCKET, [media.path, media.previewPath]);
    throw e;
  }

  await db.from("conversations").update({
    unread_count: 0,
    ai_due_at: null,
    needs_human: false,
    last_message_at: new Date().toISOString(),
    last_message_preview: preview(`[รูปภาพ] ${captionTh}`),
  }).eq("id", input.conversationId);

  return { messageId };
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
    if (s.skipped) continue;
    if (await tryAutoSend(c.id, s.options, s.needs_human, s.id)) sent++;
  }
  return { checked: due?.length ?? 0, sent };
}
