import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelType } from "./types";

const DAY = 24 * 60 * 60 * 1000;

export interface MarkReadSenders {
  line: (token: string) => Promise<void>;
  meta: (kind: "facebook" | "instagram", recipientId: string) => Promise<void>;
}

export type MarkReadResult = "marked" | "no_message" | "already_read" | "no_token" | "window_closed" | "unsupported" | "failed";

/** แจ้งแพลตฟอร์มว่าคลินิกอ่านแล้ว error แค่ log ห้ามทำให้หน้าแชทหรือการส่งข้อความพัง */
export async function markConversationReadWith(
  db: SupabaseClient,
  conversationId: string,
  senders: MarkReadSenders,
  now = Date.now(),
): Promise<MarkReadResult> {
  try {
    const { data: conv } = await db.from("conversations")
      .select("id, customer_marked_read_at, contacts(external_id), channels(type)")
      .eq("id", conversationId).single();
    if (!conv) return "no_message";

    const { data: lastIn } = await db.from("messages")
      .select("created_at, line_mark_as_read_token")
      .eq("conversation_id", conversationId).eq("direction", "in")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!lastIn) return "no_message";

    const inAt = Date.parse(lastIn.created_at as string);
    const markedAt = conv.customer_marked_read_at ? Date.parse(conv.customer_marked_read_at as string) : 0;
    if (inAt <= markedAt) return "already_read";

    const contact = (Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts) as unknown as { external_id: string };
    const channel = (Array.isArray(conv.channels) ? conv.channels[0] : conv.channels) as unknown as { type: ChannelType };

    switch (channel.type) {
      case "line": {
        // token ล่าสุดตัวเดียว LINE จะ mark ข้อความก่อนหน้าให้ทั้งหมด
        const token = lastIn.line_mark_as_read_token as string | null;
        if (!token) return "no_token";
        await senders.line(token);
        break;
      }
      case "facebook":
      case "instagram":
        if (now - inAt > DAY) return "window_closed";
        await senders.meta(channel.type, contact.external_id);
        break;
      case "web":
        break;
      default:
        return "unsupported";
    }

    // นาฬิกาแอปอาจช้ากว่าฐานข้อมูล ต้องไม่ต่ำกว่าเวลาข้อความ ไม่งั้นจะเรียก API ซ้ำ
    await db.from("conversations")
      .update({ customer_marked_read_at: new Date(Math.max(now, inAt)).toISOString() })
      .eq("id", conversationId);
    return "marked";
  } catch (e) {
    console.error("markConversationRead failed", e);
    return "failed";
  }
}

/** หาแชทจากรหัสลูกค้าบนแพลตฟอร์ม */
export async function findConversationId(db: SupabaseClient, type: ChannelType, externalId: string): Promise<string | null> {
  const { data: contact } = await db.from("contacts")
    .select("id, channels!inner(type)")
    .eq("external_id", externalId).eq("channels.type", type).maybeSingle();
  if (!contact) return null;
  const { data: conv } = await db.from("conversations").select("id").eq("contact_id", contact.id).maybeSingle();
  return (conv?.id as string | undefined) ?? null;
}

/**
 * ลูกค้าอ่านแล้ว: อัปเดตเฉพาะข้อความขาออกที่ส่งไม่เกิน upTo และยังไม่เคยอ่าน
 * upTo เป็นข้อความ ไม่ใช่ Date เพราะ created_at ละเอียดระดับไมโครวินาที ถ้าแปลงเป็น Date จะตัดข้อความล่าสุดทิ้ง
 */
export async function applyCustomerRead(db: SupabaseClient, conversationId: string, upTo: string, readAt: Date) {
  const { error } = await db.from("messages")
    .update({ read_by_customer_at: readAt.toISOString() })
    .eq("conversation_id", conversationId).eq("direction", "out")
    .is("read_by_customer_at", null).lte("created_at", upTo);
  if (error) throw error;
}
