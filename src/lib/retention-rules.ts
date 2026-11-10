/**
 * นโยบายเก็บข้อมูล (ตรงกับฟังก์ชันในฐานข้อมูล migration 055):
 * - งานที่เสร็จแล้ว (+คอมเมนต์ในงาน): ซ่อนเมื่อแชทปิด · ลบถาวรเมื่อแชทยังปิดอยู่และปิดล่าสุดครบระยะ (ค่าเริ่มต้น 30 วัน)
 *   งานค้างไม่แตะเลย
 * - นัดที่ยกเลิก: ซ่อนจากแท็บพรุ่งนี้/วันนี้/กล่องขวา · ลบถาวรเมื่อเลยวันนัดครบระยะ (ค่าเริ่มต้น 90 วัน)
 *   นัดสถานะอื่น (มาแล้ว ไม่มา รอนัด ยืนยันแล้ว ขอเลื่อน) ไม่ลบ
 */
export const RETENTION_DEFAULTS = { taskDays: 30, cancelledAppointmentDays: 90 } as const;
export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 3650;
/** ลบทีละชุดไม่เกินนี้ */
export const RETENTION_BATCH = 500;
export const RETENTION_SETTING_KEYS = { taskDays: "retention_task_days", cancelledAppointmentDays: "retention_cancelled_appointment_days" } as const;

export function normalizeRetentionDays(v: unknown, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, n));
}

const DAY = 86_400_000;

export function taskExpired(
  task: { done: boolean },
  conv: { status: string; closed_at: string | null } | null | undefined,
  now: number, days: number,
): boolean {
  return task.done && !!conv && conv.status === "closed" && !!conv.closed_at && now - Date.parse(conv.closed_at) >= days * DAY;
}

/** today = วันนี้ตามเวลาไทย (YYYY-MM-DD) */
export function cancelledAppointmentExpired(a: { status: string; appoint_date: string }, today: string, days: number): boolean {
  if (a.status !== "cancelled") return false;
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);
  return a.appoint_date <= cutoff;
}

/** เดือนตามเวลาไทย (วันที่ 1) ของเวลา ISO หรือวันที่ YYYY-MM-DD */
export function monthOf(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v.slice(0, 7)}-01`;
  const d = new Date(Date.parse(v) + 7 * 3600_000);
  return `${d.toISOString().slice(0, 7)}-01`;
}

/** เดือนที่อยู่ในช่วง from–to (YYYY-MM-DD) แบบรวมทั้งเดือน */
export function monthsInRange(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const endKey = to.slice(0, 7);
  for (let i = 0; i < 240; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > endKey) break;
    out.push(`${key}-01`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

export interface RetentionRunTotals { tasks: number; notes: number; appointments: number; events: number; series: number; batches: number }
