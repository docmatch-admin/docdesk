import { businessSeconds, type BusinessHoursConfig } from "./business-hours";

/** ไม่ตอบเกินนี้ในเวลาทำการ แชทที่มีผู้ดูแลจะแจ้งทุกคน */
export const ASSIGNEE_ESCALATE_SECONDS = 10 * 60;

/**
 * เหตุผลที่เปลี่ยนผู้ดูแลไม่ได้ null = เปลี่ยนได้
 * admin เปลี่ยนได้ทุกแชท · agent รับเคสที่ไม่มีผู้ดูแล หรือส่งต่อเคสของตัวเองให้คนอื่น
 */
export function assignError(actor: { id: string; role: string }, current: string | null, to: string | null): string | null {
  if (actor.role === "admin") return null;
  if (!current) return to === actor.id ? null : "รับเคสได้เฉพาะให้ตัวเอง";
  if (current !== actor.id) return "เปลี่ยนผู้ดูแลของแชทคนอื่นไม่ได้";
  return to ? null : "ส่งต่อเคสต้องเลือกผู้รับ";
}

/** แชทที่รอตอบนี้ต้องเตือนเจ้าหน้าที่คนนี้ไหม */
export function shouldAlertStaff(
  chat: { assigned_to: string | null; waiting_since: string | null; last_inbound_at: string | null },
  meId: string,
  hours: BusinessHoursConfig,
  now = Date.now(),
): boolean {
  if (!chat.assigned_to || chat.assigned_to === meId) return true;
  const since = chat.waiting_since ?? chat.last_inbound_at;
  return !!since && businessSeconds(since, new Date(now), hours) > ASSIGNEE_ESCALATE_SECONDS;
}

export const staffInitial = (name: string | null | undefined) => (name ?? "?").trim().slice(0, 1).toUpperCase() || "?";
