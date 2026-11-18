/** แท็กนี้หมดความหมายเมื่อลูกค้าทักกลับมาหลังกดเสร็จแล้ว แท็กอื่นเก็บไว้ */
export const CLEARED_ON_REOPEN_TAG = "นัดแล้ว";

/** แชทถัดไปที่เปิดอยู่ตามลำดับรายการ ถึงท้ายรายการแล้ววนกลับต้นรายการ */
export function nextOpenChat<T extends { id: string; status: string }>(list: T[], currentId: string): string | null {
  const at = list.findIndex((c) => c.id === currentId);
  const ordered = at === -1 ? list : [...list.slice(at + 1), ...list.slice(0, at)];
  return ordered.find((c) => c.status === "open" && c.id !== currentId)?.id ?? null;
}

/** นัดที่ยังไม่ลงระบบและงานของทีมที่ยังไม่ครบค้างในรอตอบ แม้ข้อความล่าสุดเป็นของคลินิก */
export function isWaitingForReply(c: { status: string; last_direction: string | null; booking_pending?: boolean; open_tasks?: number }): boolean {
  return c.status === "open" && (c.last_direction === "in" || !!c.booking_pending || (c.open_tasks ?? 0) > 0);
}

/**
 * ชั้นของแชทในรายการรวม (ไม่มีแท็บ "เสร็จแล้ว" แล้ว): "waiting" = ชั้นบน (รอตอบ) · "open" = ชั้นล่าง
 * · "closed" = ชั้นล่างแบบจาง + ป้าย "เสร็จ" — ลูกค้าทักใหม่ แชทเปิดเอง (logic เดิม) แล้วขึ้นชั้นบน
 */
export type InboxTab = "open" | "waiting" | "closed";
export function tabsOf(c: { status: string; last_direction: string | null; booking_pending?: boolean; open_tasks?: number }): InboxTab[] {
  if (c.status !== "open") return ["closed"];
  return isWaitingForReply(c) ? ["open", "waiting"] : ["open"];
}

export interface InboxRow {
  id: string; status: string; last_direction: string | null; booking_pending?: boolean; open_tasks?: number;
  waiting_since?: string | null; last_inbound_at?: string | null; last_message_at?: string | null;
}
const tsOr = (v: string | null | undefined, fallback: number) => { const t = Date.parse(v ?? ""); return Number.isFinite(t) ? t : fallback; };

/**
 * รายการแชทรวม 2 ชั้น: (1) รอตอบ อยู่บนสุดเสมอ รอนานสุดอยู่บน (รอเพราะนัด/งานค้างที่ไม่มีเวลารอ ต่อท้ายชั้นบน)
 * (2) ที่เหลือรวมแชทที่เสร็จแล้ว เรียงตามข้อความล่าสุด · onlyWaiting = ปุ่มกรอง "รอตอบ"
 */
export function inboxOrder<T extends InboxRow>(rows: T[], opts: { onlyWaiting?: boolean } = {}): T[] {
  const uniq = [...new Map(rows.map((r) => [r.id, r])).values()];
  const waiting = uniq.filter(isWaitingForReply).sort((a, b) =>
    tsOr(a.waiting_since ?? a.last_inbound_at, Infinity) - tsOr(b.waiting_since ?? b.last_inbound_at, Infinity)
    || Number(!!b.booking_pending) - Number(!!a.booking_pending));
  if (opts.onlyWaiting) return waiting;
  const rest = uniq.filter((r) => !isWaitingForReply(r)).sort((a, b) => tsOr(b.last_message_at, 0) - tsOr(a.last_message_at, 0));
  return [...waiting, ...rest];
}

/** กดเสร็จแล้วหรือย้ายอัตโนมัติ: ล้าง ai_due_at ด้วย ไม่อย่างนั้น cron จะให้ AI ตอบแทนในแชทที่เสร็จแล้ว */
export const CLOSE_PATCH = { status: "closed", needs_human: false, ai_due_at: null } as const;

/** แชทที่มีแท็กเหล่านี้ยังมีงานค้าง ไม่ย้ายไปเสร็จแล้วเอง */
export const AUTO_CLOSE_EXEMPT_TAGS = ["ตามต่อ", "รอนัด"];
export const DEFAULT_AUTO_CLOSE_HOURS = 24;

/** 0 = ปิด ค่าเสียใช้ค่าเริ่มต้น ไม่ให้ค่าติดลบทำให้ทุกแชทถูกปิด */
export function normalizeAutoCloseHours(value: unknown): number {
  const hours = Number(value);
  return value !== null && Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_AUTO_CLOSE_HOURS;
}

const WAIT_WARN_MINUTES = 10;
const WAIT_LATE_MINUTES = 30;

/** "รอ 12 นาที" พร้อมระดับสี: เกิน 10 นาทีส้ม เกิน 30 นาทีแดง */
export function waitBadge(since: string | null, now = Date.now()): { text: string; level: "normal" | "warn" | "late" } | null {
  if (!since) return null;
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const text = days >= 1 ? `รอ ${days} วัน`
    : hours >= 1 ? `รอ ${hours} ชม. ${minutes % 60} นาที`
    : minutes < 1 ? "รอไม่ถึงนาที"
    : `รอ ${minutes} นาที`;
  return { text, level: minutes > WAIT_LATE_MINUTES ? "late" : minutes > WAIT_WARN_MINUTES ? "warn" : "normal" };
}

/** ป้ายบนแท็บเบราว์เซอร์ */
export function titleWithCount(title: string, count: number): string {
  const base = title.replace(/^\(\d+\+?\)\s*/, "");
  return count > 0 ? `(${count > 99 ? "99+" : count}) ${base}` : base;
}
