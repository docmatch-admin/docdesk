import { sendPushToStaff } from "./booking-store";
import { getSetting } from "./mode";
import {
  DEFAULT_SENSITIVE_KEYWORDS, normalizeSensitiveKeywords, SENSITIVE_NOTIFY_TEXT, SENSITIVE_TAG,
} from "./sensitive-rules";
import { supabaseAdmin } from "./supabase/admin";

export const loadSensitiveKeywords = async (): Promise<string[]> =>
  normalizeSensitiveKeywords(await getSetting<unknown>("sensitive_keywords", DEFAULT_SENSITIVE_KEYWORDS));

export type SensitiveAction = "open" | "reveal" | "export" | "untag";

export async function logSensitiveAccess(staffId: string, conversationId: string, action: SensitiveAction) {
  const { error } = await supabaseAdmin().from("sensitive_access_log").insert({ staff_id: staffId, conversation_id: conversationId, action });
  if (error) console.error("sensitive log failed", error.code);
}

/**
 * ติดแชทลับ ถ้าติดอยู่แล้วคืน false ไม่บอกเนื้อหาใน reason เพราะคนอ่านอาจไม่ต้องรู้ว่าตรงกับคำไหน
 * เอาตัวอย่างคำตอบของแชทนี้ออก และถอนผู้ดูแลที่ไม่มีสิทธิ์
 */
export async function markConversationSensitive(conversationId: string, reason: string): Promise<boolean> {
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("sensitive, assigned_to, archived").eq("id", conversationId).maybeSingle();
  if (!conv || conv.sensitive) return false;
  const assignee = (conv.assigned_to as string | null) ?? null;
  const { error } = await db.from("conversations").update({
    sensitive: true, sensitive_since: new Date().toISOString(), sensitive_reason: reason,
    // แชทเก่าส่งข้อความไม่ได้ จึงไม่มีอะไรให้คนตอบ
    needs_human: !conv.archived,
  }).eq("id", conversationId);
  if (error) throw error;
  await db.rpc("set_conversation_tag", { p_conversation: conversationId, p_tag: SENSITIVE_TAG, p_action: "add", p_by: "rule" });

  const { data: msgs } = await db.from("messages").select("id").eq("conversation_id", conversationId);
  const ids = ((msgs ?? []) as { id: string }[]).map((m) => m.id);
  if (ids.length) await db.from("reply_examples").delete().in("source_message_id", ids);

  if (assignee) {
    const { data: staff } = await db.from("staff").select("role, can_view_sensitive").eq("id", assignee).maybeSingle();
    if (staff && staff.role !== "admin" && !staff.can_view_sensitive) {
      await db.rpc("set_assignee", { p_conversation: conversationId, p_to: null, p_by: null });
    }
  }
  return true;
}

/** admin เท่านั้น ผู้เรียกตรวจสิทธิ์แล้ว ใช้ by = rule เพื่อให้ติดใหม่ได้เมื่อเจอคำสำคัญอีก */
export async function unmarkConversationSensitive(conversationId: string, staffId: string) {
  const db = supabaseAdmin();
  await db.from("conversations").update({ sensitive: false, sensitive_since: null, sensitive_reason: null }).eq("id", conversationId);
  await db.rpc("set_conversation_tag", { p_conversation: conversationId, p_tag: SENSITIVE_TAG, p_action: "remove", p_by: "rule" });
  await logSensitiveAccess(staffId, conversationId, "untag");
}

/** ส่งเฉพาะคนที่มีสิทธิ์ ข้อความตายตัว ไม่มีชื่อหรือเนื้อหา */
export async function notifySensitiveChat(sender?: Parameters<typeof sendPushToStaff>[2]): Promise<number> {
  const { data } = await supabaseAdmin().from("staff").select("id, role, can_view_sensitive, active");
  const allowed = ((data ?? []) as { id: string; role: string; can_view_sensitive: boolean; active: boolean }[])
    .filter((s) => s.active && (s.role === "admin" || s.can_view_sensitive)).map((s) => s.id);
  return sendPushToStaff(allowed, { title: "DocDesk", body: SENSITIVE_NOTIFY_TEXT, url: "/inbox" }, sender);
}
