// ส่งแจ้งเตือน push: ข้อความใหม่จากลูกค้า · แชทถูกมอบหมายให้ · (นัดที่ AI รับไว้: pushPendingBookings ใน booking-store)
// พลาดต้องไม่ทำให้ข้อความลูกค้า/การมอบหมายล้ม — ทุกฟังก์ชันจับ error เอง
import { sendPushToStaff, type PushSender } from "./booking-store";
import { assignedPush, newMessageAudience, newMessagePush, shouldThrottle, viewingStaff, type StaffLite } from "./push-rules";
import { supabaseAdmin } from "./supabase/admin";

interface ChatInfo { id: string; name: string | null; channel: string | null; assignedTo: string | null; sensitive: boolean; lastPushAt: string | null }

async function chatInfo(conversationId: string): Promise<ChatInfo | null> {
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("*").eq("id", conversationId).maybeSingle();
  if (!conv) return null;
  const [{ data: contact }, { data: channel }] = await Promise.all([
    db.from("contacts").select("display_name").eq("id", conv.contact_id as string).maybeSingle(),
    db.from("channels").select("type").eq("id", conv.channel_id as string).maybeSingle(),
  ]);
  return {
    id: conversationId,
    name: (contact?.display_name as string | null) ?? null,
    channel: (channel?.type as string | null) ?? null,
    assignedTo: (conv.assigned_to as string | null) ?? null,
    sensitive: !!conv.sensitive,
    lastPushAt: (conv.last_push_at as string | null) ?? null,
  };
}

/** จำนวนแชทที่ยังไม่อ่าน (ตัวเลขบนไอคอนแอป) — คนไม่มีสิทธิ์แชทลับไม่นับแชทลับ */
export async function unreadChatCounts(): Promise<{ all: number; nonSensitive: number }> {
  const { data } = await supabaseAdmin().from("conversations").select("id, sensitive, archived").eq("status", "open").gt("unread_count", 0);
  const rows = ((data ?? []) as { sensitive: boolean | null; archived: boolean | null }[]).filter((r) => !r.archived);
  return { all: rows.length, nonSensitive: rows.filter((r) => !r.sensitive).length };
}

async function staffList(): Promise<(StaffLite & { canViewSensitive: boolean })[]> {
  const { data } = await supabaseAdmin().from("staff").select("id, role, active, can_view_sensitive");
  return ((data ?? []) as { id: string; role: string; active: boolean; can_view_sensitive: boolean | null }[])
    .map((s) => ({ id: s.id, role: s.role, active: s.active, canViewSensitive: s.role === "admin" || !!s.can_view_sensitive }));
}

async function badgeFor() {
  const [counts, staff] = await Promise.all([unreadChatCounts(), staffList()]);
  const sees = new Map(staff.map((s) => [s.id, s.canViewSensitive]));
  return (id: string) => (sees.get(id) ? counts.all : counts.nonSensitive);
}

/** ข้อความใหม่จากลูกค้า (เรียกหลังบันทึกข้อความ เฉพาะเมื่อแชทรอตอบ) */
export async function notifyNewMessage(conversationId: string, now = Date.now(), sender?: PushSender): Promise<number> {
  try {
    const db = supabaseAdmin();
    const chat = await chatInfo(conversationId);
    if (!chat || chat.sensitive || shouldThrottle(chat.lastPushAt, now)) return 0;
    const [staff, { data: presence }] = await Promise.all([
      staffList(),
      db.from("staff_presence").select("staff_id, conversation_id, seen_at").eq("conversation_id", conversationId),
    ]);
    const viewing = viewingStaff((presence ?? []) as { staff_id: string; conversation_id: string | null; seen_at: string }[], conversationId, now);
    const to = newMessageAudience(chat, staff, viewing);
    if (!to.length) return 0;
    const msg = newMessagePush(chat);
    const sent = await sendPushToStaff(to, msg, sender, { tag: msg.tag, badgeFor: await badgeFor() });
    // ยังไม่ได้รัน migration 065: ไม่มีคอลัมน์ last_push_at ก็แค่ไม่กันรัว
    const { error } = await db.from("conversations").update({ last_push_at: new Date(now).toISOString() }).eq("id", conversationId);
    if (error) console.error("last_push_at", error.message);
    return sent;
  } catch (e) {
    console.error("new message push failed", e);
    return 0;
  }
}

/** แชทถูกมอบหมายให้ (ไม่แจ้งถ้ารับเคสเอง) */
export async function notifyAssigned(conversationId: string, to: string | null, by: string, sender?: PushSender): Promise<number> {
  if (!to || to === by) return 0;
  try {
    const chat = await chatInfo(conversationId);
    if (!chat) return 0;
    const msg = assignedPush(chat);
    return await sendPushToStaff([to], msg, sender, { tag: msg.tag, badgeFor: await badgeFor() });
  } catch (e) {
    console.error("assign push failed", e);
    return 0;
  }
}

/** หน้าแชทแจ้งว่ากำลังเปิดแชทไหน (null = ไม่ได้เปิด/ออกจากหน้าแล้ว) */
export async function setPresence(staffId: string, conversationId: string | null, now = Date.now()): Promise<void> {
  const { error } = await supabaseAdmin().from("staff_presence")
    .upsert({ staff_id: staffId, conversation_id: conversationId, seen_at: new Date(now).toISOString() }, { onConflict: "staff_id" });
  if (error) console.error("presence", error.message);
}
