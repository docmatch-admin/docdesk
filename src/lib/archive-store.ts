import { randomUUID } from "node:crypto";
import { matchSensitive } from "./sensitive-rules";
import { loadSensitiveKeywords, markConversationSensitive } from "./sensitive-store";
import { supabaseAdmin } from "./supabase/admin";

const preview = (s: string) => s.replace(/\s+/g, " ").slice(0, 120);

export const sameDisplayName = (a: string | null | undefined, b: string | null | undefined) => {
  const norm = (s: string | null | undefined) => (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  return !!norm(a) && norm(a) === norm(b);
};

async function lineChannelId(): Promise<string | null> {
  const { data } = await supabaseAdmin().from("channels").select("id").eq("type", "line").order("created_at").limit(1).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/** external_id สุ่ม ไม่มีทางตรงกับ webhook ซึ่งจะทำให้ส่งข้อความผิดคน */
export async function createArchivedChat(displayName: string, lineOaChatId: string | null, last: { at: string; text: string } | null): Promise<string | null> {
  const db = supabaseAdmin();
  const channelId = await lineChannelId();
  if (!channelId) return null;
  const { data: contact, error: contactError } = await db.from("contacts").insert({
    channel_id: channelId, external_id: `archived:${randomUUID()}`, display_name: displayName, platform_name: displayName, line_oa_chat_id: lineOaChatId,
  }).select("id").single();
  if (contactError || !contact) throw contactError ?? new Error("สร้างรายชื่อไม่สำเร็จ");
  const { data: conv, error } = await db.from("conversations").insert({
    channel_id: channelId, contact_id: contact.id, archived: true, status: "closed", needs_human: false,
    // เวลาจากข้อความจริง แท็บเสร็จแล้วเรียงตาม closed_at แชทเก่าจะได้ไม่ขึ้นบนสุดตอนนำเข้า
    ...(last ? { last_message_at: last.at, closed_at: last.at, last_message_preview: preview(last.text) } : {}),
  }).select("id").single();
  if (error || !conv) throw error ?? new Error("สร้างแชทไม่สำเร็จ");
  return conv.id as string;
}

export const findArchivedChat = async (lineOaChatId: string): Promise<string | null> => {
  const db = supabaseAdmin();
  const { data: contact } = await db.from("contacts").select("id").eq("line_oa_chat_id", lineOaChatId).maybeSingle();
  if (!contact) return null;
  const { data: conv } = await db.from("conversations").select("id").eq("contact_id", contact.id).maybeSingle();
  return (conv?.id as string | undefined) ?? null;
};

async function logArchive(action: "merge" | "dismiss" | "split", conversationId: string, chatId: string | null, messages: number, staffId: string) {
  const { error } = await supabaseAdmin().from("archive_merge_log").insert({
    action, conversation_id: conversationId, line_oa_chat_id: chatId, messages, staff_id: staffId,
  });
  if (error) console.error("archive log failed", error.code);
}

export interface ArchiveCandidate { id: string; messages: number; from: string | null; to: string | null; sensitive: boolean }

/**
 * แชทเก่าชื่อเดียวกันที่ควรถามเจ้าหน้าที่ ไม่รวมเอง
 * ถามเฉพาะ LINE ที่ยังไม่เคยรวม และซ่อนแชทลับจากคนไม่มีสิทธิ์
 */
export async function findArchiveCandidates(conversationId: string, canViewSensitive: boolean): Promise<ArchiveCandidate[]> {
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("id, contact_id, channel_id, archived, archive_merged_at").eq("id", conversationId).maybeSingle();
  if (!conv || conv.archived || conv.archive_merged_at) return [];
  const channelId = await lineChannelId();
  if (conv.channel_id !== channelId) return [];
  const { data: contact } = await db.from("contacts").select("display_name").eq("id", conv.contact_id as string).maybeSingle();
  const name = (contact?.display_name as string | null)?.trim();
  if (!name) return [];

  // ชื่อจากไฟล์นำเข้ากับชื่อจาก LINE อาจต่างกันที่ช่องว่างหรือตัวพิมพ์ เทียบแบบปรับแล้ว
  const { data: others } = await db.from("contacts").select("id, display_name").eq("channel_id", channelId).neq("id", conv.contact_id as string);
  const ids = ((others ?? []) as { id: string; display_name: string | null }[])
    .filter((c) => sameDisplayName(c.display_name, name)).map((c) => c.id);
  if (!ids.length) return [];
  const { data: chats } = await db.from("conversations").select("id, sensitive").in("contact_id", ids).eq("archived", true);
  const { data: dismissed } = await db.from("archive_merge_dismissed").select("archived_conversation_id").eq("conversation_id", conversationId);
  const skip = new Set(((dismissed ?? []) as { archived_conversation_id: string }[]).map((d) => d.archived_conversation_id));

  const out: ArchiveCandidate[] = [];
  for (const c of (chats ?? []) as { id: string; sensitive: boolean }[]) {
    if (skip.has(c.id) || (c.sensitive && !canViewSensitive)) continue;
    const { data: rows } = await db.from("messages").select("created_at").eq("conversation_id", c.id).order("created_at");
    const times = ((rows ?? []) as { created_at: string }[]).map((r) => r.created_at);
    out.push({ id: c.id, messages: times.length, from: times[0] ?? null, to: times.at(-1) ?? null, sensitive: !!c.sensitive });
  }
  return out;
}

export type ArchiveProblem = "not_found" | "forbidden";

/** ย้ายข้อความเข้าแชทปัจจุบันแล้วลบแชทเก่า แก้ลำดับ ย้ายก่อนลบ ถ้าล้มกลางคันข้อความไม่หาย และกดซ้ำได้ */
export async function mergeArchivedChat(targetId: string, archivedId: string, staffId: string, canViewSensitive: boolean): Promise<{ moved: number } | ArchiveProblem> {
  const db = supabaseAdmin();
  const candidates = await findArchiveCandidates(targetId, canViewSensitive);
  if (!candidates.some((c) => c.id === archivedId)) return "not_found";
  const { data: archived } = await db.from("conversations").select("contact_id, sensitive, tags").eq("id", archivedId).maybeSingle();
  if (!archived) return "not_found";
  const { data: target } = await db.from("conversations").select("tags").eq("id", targetId).maybeSingle();
  const { data: contact } = await db.from("contacts").select("line_oa_chat_id").eq("id", archived.contact_id as string).maybeSingle();

  // ติดลับก่อนย้าย คนไม่มีสิทธิ์จะได้ไม่เห็นข้อความแม้ชั่วขณะ
  if (archived.sensitive) await markConversationSensitive(targetId, "รวมประวัติ");
  for (const tag of (archived.tags ?? []) as string[]) {
    if (((target?.tags ?? []) as string[]).includes(tag)) continue;
    await db.rpc("set_conversation_tag", { p_conversation: targetId, p_tag: tag, p_action: "add", p_by: "rule" });
  }
  const { data: moved, error } = await db.from("messages").update({ conversation_id: targetId }).eq("conversation_id", archivedId).select("id");
  if (error) throw error;
  await db.from("conversations").update({ archive_merged_at: new Date().toISOString() }).eq("id", targetId);
  await logArchive("merge", targetId, (contact?.line_oa_chat_id as string | null) ?? null, moved?.length ?? 0, staffId);
  await db.from("conversations").delete().eq("id", archivedId);
  await db.from("contacts").delete().eq("id", archived.contact_id as string);
  return { moved: moved?.length ?? 0 };
}

export async function dismissArchivedChat(targetId: string, archivedId: string, staffId: string, canViewSensitive: boolean): Promise<boolean> {
  const db = supabaseAdmin();
  const candidates = await findArchiveCandidates(targetId, canViewSensitive);
  if (!candidates.some((c) => c.id === archivedId)) return false;
  const { data: archived } = await db.from("conversations").select("contact_id").eq("id", archivedId).maybeSingle();
  const { data: contact } = await db.from("contacts").select("line_oa_chat_id").eq("id", archived?.contact_id as string).maybeSingle();
  await db.from("archive_merge_dismissed").upsert({
    conversation_id: targetId, archived_conversation_id: archivedId, dismissed_by: staffId,
  }, { onConflict: "conversation_id,archived_conversation_id" });
  await logArchive("dismiss", targetId, (contact?.line_oa_chat_id as string | null) ?? null, 0, staffId);
  return true;
}

/** จับคู่ด้วยชื่อผิดคน: ย้ายข้อความนำเข้ากลับเป็นแชทเก่า แยกตามห้องเดิม และไม่ถามให้รวมอีก */
/** "replied" = เจ้าหน้าที่ตอบในแชทนี้แล้ว ถือว่ายืนยันว่าประวัติที่นำเข้าเป็นคนเดียวกัน ไม่ให้แยก */
export async function splitImportedHistory(conversationId: string, staffId: string): Promise<{ moved: number; chats: number } | "replied" | null> {
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("contact_id, archived, sensitive").eq("id", conversationId).maybeSingle();
  if (!conv || conv.archived) return null;
  const { data: rows } = await db.from("messages").select("id, body, created_at, line_oa_chat_id").eq("conversation_id", conversationId).eq("imported", true).order("created_at");
  const imported = (rows ?? []) as { id: string; body: string; created_at: string; line_oa_chat_id: string | null }[];
  if (!imported.length) return null;
  const { data: replied } = await db.from("messages").select("id").eq("conversation_id", conversationId)
    .eq("direction", "out").eq("sender_type", "staff").eq("imported", false).limit(1);
  if (replied?.length) return "replied";
  const { data: contact } = await db.from("contacts").select("display_name").eq("id", conv.contact_id as string).maybeSingle();
  const name = (contact?.display_name as string | null) ?? "ลูกค้า";
  const keywords = await loadSensitiveKeywords();

  const groups = new Map<string | null, typeof imported>();
  for (const m of imported) groups.set(m.line_oa_chat_id, [...(groups.get(m.line_oa_chat_id) ?? []), m]);
  let moved = 0;
  for (const [chatId, list] of groups) {
    const last = list.at(-1) as (typeof imported)[number];
    const archivedId = await createArchivedChat(name, chatId, { at: last.created_at, text: last.body });
    if (!archivedId) continue;
    // ติดลับก่อนย้าย
    if (list.some((m) => matchSensitive(m.body, keywords))) await markConversationSensitive(archivedId, "นำเข้า");
    const { error } = await db.from("messages").update({ conversation_id: archivedId }).in("id", list.map((m) => m.id));
    if (error) throw error;
    moved += list.length;
    await db.from("archive_merge_dismissed").upsert({
      conversation_id: conversationId, archived_conversation_id: archivedId, dismissed_by: staffId,
    }, { onConflict: "conversation_id,archived_conversation_id" });
    await logArchive("split", conversationId, chatId, list.length, staffId);
  }
  await db.from("conversations").update({ archive_merged_at: null }).eq("id", conversationId);
  return { moved, chats: groups.size };
}
