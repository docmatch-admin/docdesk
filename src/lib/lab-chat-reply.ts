// คนไข้พิมพ์ขอผลแล็บในแชท: ตอบแค่ปุ่มลิงก์ไปหน้า "ผลแล็บของฉัน" (LIFF) — ไม่เรียก LLM ไม่อ่าน/ไม่สรุปผล
// ไม่แตะข้อมูลผลแล็บเลย (ตัวตรวจสิทธิ์ดูผลอยู่ที่หน้า LIFF)
import { lineSendMessages } from "./channels/line";
import { claimReplyTokenWithAge } from "./channels/reply-token";
import { isLabResultRequest, LAB_LINK_REPLY_TEXT, labLinkFlex, labMineUrl } from "./lab-results-rules";
import { supabaseAdmin } from "./supabase/admin";

const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL || "https://docdesk-tau.vercel.app").replace(/\/$/, "");

/** ตอบด้วยปุ่มลิงก์ถ้าเป็นข้อความขอผลแล็บในแชท LINE · คืน true = ตอบแล้ว (ไม่ต้องให้ AI ร่าง/ตอบต่อ) */
export async function replyLabLinkIfAsked(conversationId: string, text: string | null | undefined, replyToken?: string): Promise<boolean> {
  if (!isLabResultRequest(text)) return false;
  const liffId = process.env.NEXT_PUBLIC_LINE_LIFF_ID?.trim();
  if (!liffId) return false;
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("id, sensitive, contacts(external_id), channels(type)").eq("id", conversationId).maybeSingle();
  if (!conv || conv.sensitive) return false;
  const contact = (Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts) as { external_id?: string } | null;
  const channel = (Array.isArray(conv.channels) ? conv.channels[0] : conv.channels) as { type?: string } | null;
  if (channel?.type !== "line" || !contact?.external_id) return false;

  const url = labMineUrl(liffId, appUrl());
  const claimed = replyToken ? undefined : await claimReplyTokenWithAge(db, conversationId);
  await lineSendMessages(contact.external_id, [labLinkFlex(url)], replyToken ?? claimed?.token, {
    kind: "chat", conversationId, tokenAgeMs: claimed?.ageMs ?? (replyToken ? 0 : null),
  });
  const body = `${LAB_LINK_REPLY_TEXT}\n${url}`;
  await db.from("messages").insert({ conversation_id: conversationId, direction: "out", sender_type: "ai", body, language: "th" });
  await db.from("conversations").update({
    unread_count: 0, ai_due_at: null, needs_human: false, last_message_at: new Date().toISOString(), last_message_preview: LAB_LINK_REPLY_TEXT.slice(0, 120),
  }).eq("id", conversationId);
  return true;
}
