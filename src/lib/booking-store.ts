import {
  DEFAULT_BOOKING_TEMPLATES, extractPhone, localToday, maskBookingPii, normalizeBookingTemplates, parseBookingDate, parseBookingTime,
  type ActiveBooking, type BookingCatalog, type BookingTemplates,
} from "./booking-rules";
import { getSetting, isWithinBusinessHours, type BusinessHours } from "./mode";
import { supabaseAdmin } from "./supabase/admin";
import { HIDDEN_LINE_PREFIX, UNAVAILABLE_TITLE } from "./website-sync";
import type { SuggestionOption } from "./types";
import { pushDisabledStaff } from "./preferences-store";

/** หมวดนี้ไม่ใช่บริการ เช่น เวลาทำการหรือนโยบาย จึงไม่นำมาจับชื่อบริการ */
const NON_SERVICE_CATEGORIES = ["ข้อมูลคลินิก", "นโยบายการตอบ", "แนวทางซักอาการ"];

export const loadBookingTemplates = async (): Promise<BookingTemplates> =>
  normalizeBookingTemplates(await getSetting<unknown>("booking_templates", DEFAULT_BOOKING_TEMPLATES));

export const loadBusinessHours = () => getSetting<BusinessHours>("business_hours", { tz: "Asia/Bangkok", days: {} });

/** ระบุคอลัมน์เสมอ ที่นี่ใช้ service role ซึ่งอ่านต้นทุนได้ */
export async function loadBookingCatalog(): Promise<BookingCatalog> {
  const db = supabaseAdmin();
  const [{ data: knowledge }, { data: items }, { data: packages }] = await Promise.all([
    db.from("knowledge_items").select("category, title, content").eq("active", true),
    db.from("lab_items").select("name_en, name_th").eq("active", true),
    db.from("lab_packages").select("name").eq("active", true),
  ]);
  const rows = (knowledge ?? []) as { category: string; title: string; content: string }[];
  const services = rows.filter((k) => !NON_SERVICE_CATEGORIES.includes(k.category) && k.title !== UNAVAILABLE_TITLE);
  const unavailableLines = (rows.find((k) => k.title === UNAVAILABLE_TITLE)?.content ?? "").split("\n");
  return {
    names: [
      ...services.map((k) => k.title),
      ...((items ?? []) as { name_en: string; name_th: string }[]).flatMap((i) => [i.name_en, i.name_th]),
      ...((packages ?? []) as { name: string }[]).map((p) => p.name),
    ].filter(Boolean),
    contents: services.map((k) => k.content),
    unavailableText: unavailableLines.filter((l) => !l.startsWith(HIDDEN_LINE_PREFIX)).join("\n"),
    hiddenServices: unavailableLines.filter((l) => l.startsWith(HIDDEN_LINE_PREFIX)).map((l) => l.slice(HIDDEN_LINE_PREFIX.length)),
  };
}

export interface BookingRow extends ActiveBooking {
  id: string;
  conversation_id: string;
  name: string | null;
  phone: string | null;
  status: "ai_confirmed" | "recorded" | "cancelled";
}

const BOOKING_COLUMNS = 'id, conversation_id, service, "date", "time", name, phone, status';

/** นัดของแชทนี้ ใช้ลบชื่อและเบอร์ก่อนส่งให้ AI ทุกสถานะ */
export async function loadConversationBookings(conversationId: string): Promise<BookingRow[]> {
  const { data } = await supabaseAdmin().from("bookings").select(BOOKING_COLUMNS)
    .eq("conversation_id", conversationId).order("created_at", { ascending: false });
  return (data ?? []) as unknown as BookingRow[];
}

export const activeBookings = (rows: BookingRow[], today: string) =>
  rows.filter((b) => b.status !== "cancelled" && b.date >= today);

/**
 * ส่งคำยืนยันแล้ว: บันทึกนัด หรืออัปเดตนัดเดิมถ้าลูกค้าขอเปลี่ยนเวลา
 * ชื่อต้องปรากฏในข้อความลูกค้าจริง และเบอร์ดึงด้วยโค้ด กัน AI แต่งข้อมูลส่วนตัว
 */
export async function saveConfirmedBooking(
  conversationId: string,
  booking: NonNullable<SuggestionOption["booking"]>,
  messageId: string | null,
  now = Date.now(),
): Promise<void> {
  const db = supabaseAdmin();
  const date = parseBookingDate(booking.date);
  const time = parseBookingTime(booking.time);
  if (!booking.service || !date || !time) throw new Error("ข้อมูลนัดไม่ครบ");

  const [{ data: conv }, { data: inbound }, rows, hours] = await Promise.all([
    db.from("conversations").select("contact_id").eq("id", conversationId).single(),
    db.from("messages").select("body, body_th").eq("conversation_id", conversationId).eq("direction", "in").neq("imported", true)
      .order("created_at", { ascending: false }).limit(200),
    loadConversationBookings(conversationId),
    loadBusinessHours(),
  ]);
  const { data: contact } = await db.from("contacts").select("display_name, note").eq("id", conv?.contact_id as string).maybeSingle();
  const texts = ((inbound ?? []) as { body: string; body_th: string | null }[]).reverse().flatMap((m) => [m.body, m.body_th ?? ""]);
  const named = booking.name && texts.some((t) => t.includes(booking.name as string)) ? booking.name : null;
  const phone = extractPhone(texts) ?? extractPhone([(contact?.note as string | null) ?? ""]);

  const active = activeBookings(rows, localToday(now, hours.tz || "Asia/Bangkok"));
  const target = booking.is_change ? active[0] : active.find((b) => b.service === booking.service);
  if (target) {
    const wasRecorded = target.status === "recorded";
    const { error } = await db.from("bookings").update({
      service: booking.service, date, time, status: "ai_confirmed",
      name: named ?? target.name, phone: phone ?? target.phone,
      confirmed_message_id: messageId, recorded_at: null, recorded_by: null, last_push_at: null,
      updated_at: new Date(now).toISOString(),
    }).eq("id", target.id);
    if (error) throw error;
    // นัดในระบบของคลินิกต้องแก้ใหม่ จึงยังไม่ถือว่านัดแล้ว
    if (wasRecorded) {
      await db.rpc("set_conversation_tag", { p_conversation: conversationId, p_tag: "นัดแล้ว", p_action: "remove", p_by: "rule" });
    }
    return;
  }
  const { error } = await db.from("bookings").insert({
    conversation_id: conversationId,
    service: booking.service, date, time,
    name: named ?? (contact?.display_name as string | null) ?? null,
    phone,
    status: "ai_confirmed",
    confirmed_message_id: messageId,
  });
  if (error) throw error;
}

/** ลบชื่อและเบอร์ของนัดออกก่อนเก็บลง reply_examples */
export async function maskForLearning(conversationId: string, text: string): Promise<string> {
  return maskBookingPii(text, await loadConversationBookings(conversationId));
}

export async function cancelBooking(id: string, conversationId: string): Promise<void> {
  const db = supabaseAdmin();
  const { data } = await db.from("bookings").select("status").eq("id", id).eq("conversation_id", conversationId).maybeSingle();
  if (!data || data.status === "cancelled") return;
  await db.from("bookings").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", id);
  if (data.status === "recorded") {
    await db.rpc("set_conversation_tag", { p_conversation: conversationId, p_tag: "นัดแล้ว", p_action: "remove", p_by: "rule" });
  }
}

// ---------------------------------------------------------------------------
// แจ้งเตือนบนเครื่องเจ้าหน้าที่
// ---------------------------------------------------------------------------
export const PUSH_REPEAT_MS = 3 * 60_000;

/** ครั้งแรกแจ้งทันที ส่วนซ้ำทุก 3 นาทีเฉพาะเวลาทำการ กลางคืนไม่ปลุกทั้งคืน แล้วเริ่มซ้ำเมื่อเปิดทำการ */
export function shouldPushBooking(lastPushAt: string | null, hours: BusinessHours, now: number): boolean {
  if (!lastPushAt) return true;
  return now - Date.parse(lastPushAt) >= PUSH_REPEAT_MS && isWithinBusinessHours(hours, new Date(now));
}

type PushSender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<void>;

async function defaultSender(): Promise<PushSender | null> {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  const { default: webpush } = await import("web-push");
  webpush.setVapidDetails("https://docdesk-tau.vercel.app", publicKey, privateKey);
  return async (sub, payload) => { await webpush.sendNotification(sub, payload); };
}

/** staffIds = null ส่งทุกเครื่อง คืนจำนวนที่ส่งสำเร็จ */
export async function sendPushToStaff(staffIds: string[] | null, message: { title: string; body: string; url: string }, sender?: PushSender): Promise<number> {
  const db = supabaseAdmin();
  const send = sender ?? (await defaultSender());
  if (!send) return 0;
  const [{ data: subs }, muted] = await Promise.all([db.from("push_subscriptions").select("endpoint, staff_id, p256dh, auth"), pushDisabledStaff()]);
  // ผู้ใช้ที่ปิดแจ้งเตือนในหมวด "การแสดงผล" ไม่ได้รับทุกเครื่อง
  const rows = ((subs ?? []) as { endpoint: string; staff_id: string; p256dh: string; auth: string }[])
    .filter((s) => (!staffIds || staffIds.includes(s.staff_id)) && !muted.has(s.staff_id));
  const payload = JSON.stringify(message);
  let sent = 0;
  for (const s of rows) {
    try {
      await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      // เครื่องยกเลิกการแจ้งเตือนแล้ว
      if (status === 404 || status === 410) await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      else console.error("push failed", status);
    }
  }
  return sent;
}

/** เรียกทุกนาทีจาก cron ข้อความไม่มีชื่อ เบอร์ หรือบริการ เพราะขึ้นบนหน้าจอล็อกและผ่าน push service ภายนอก */
export async function pushPendingBookings(now = Date.now(), sender?: PushSender): Promise<number> {
  const db = supabaseAdmin();
  const { data: pending } = await db.from("bookings").select("id, last_push_at").eq("status", "ai_confirmed");
  const rows = (pending ?? []) as { id: string; last_push_at: string | null }[];
  if (!rows.length) return 0;
  const hours = await loadBusinessHours();
  const due = rows.filter((b) => shouldPushBooking(b.last_push_at, hours, now));
  if (!due.length) return 0;

  const sent = await sendPushToStaff(null, { title: "📅 ยังไม่ลงนัด", body: `มีนัดรอลงระบบ ${rows.length} รายการ`, url: "/inbox" }, sender);
  await db.from("bookings").update({ last_push_at: new Date(now).toISOString() }).in("id", due.map((b) => b.id));
  return sent;
}
