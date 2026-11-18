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

const WAIT_WARN_MINUTES = 5;
const WAIT_LATE_MINUTES = 15;

/** "รอ 12 นาที" พร้อมระดับสี: ไม่ถึง 5 นาทีเทา · 5–15 นาทีเหลือง · เกิน 15 นาทีแดง */
export function waitBadge(since: string | null, now = Date.now()): { text: string; level: "normal" | "warn" | "late" } | null {
  if (!since) return null;
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const text = days >= 1 ? `รอ ${days} วัน`
    : hours >= 1 ? `รอ ${hours} ชม. ${minutes % 60} นาที`
    : minutes < 1 ? "รอไม่ถึงนาที"
    : `รอ ${minutes} นาที`;
  return { text, level: minutes > WAIT_LATE_MINUTES ? "late" : minutes >= WAIT_WARN_MINUTES ? "warn" : "normal" };
}

/** ป้ายบนแท็บเบราว์เซอร์ */
export function titleWithCount(title: string, count: number): string {
  const base = title.replace(/^\(\d+\+?\)\s*/, "");
  return count > 0 ? `(${count > 99 ? "99+" : count}) ${base}` : base;
}

// ---------------------------------------------------------------------------
// รายการแชทแบบคิวงาน: 3 ช่วงตายตัว รอตอบ → งานค้าง → ล่าสุด
// ---------------------------------------------------------------------------
/** งานค้างของแชท (เรียงตามความด่วน: ตัวแรกด่วนสุด) */
export type WorkKind = "booking" | "reschedule" | "failed" | "tasks" | "ai_review";
export const WORK_PRIORITY: WorkKind[] = ["booking", "reschedule", "failed", "tasks", "ai_review"];
/** date/time: วันเวลาที่เกี่ยวกับงาน (นัดที่ขอยืนยัน / วันที่คนไข้ขอเลื่อนไป) */
export interface WorkItem { kind: WorkKind; since: string; count?: number; date?: string | null; time?: string | null }
export type WorkMap = Record<string, WorkItem[]>;

const MONTH_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
/** "2026-11-19" → "19 พ.ย." */
export const shortThaiDate = (d: string | null | undefined) =>
  d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${Number(d.slice(8, 10))} ${MONTH_SHORT[Number(d.slice(5, 7)) - 1]}` : "";

export function workLabel(item: WorkItem): string {
  const when = [shortThaiDate(item.date), item.time ? String(item.time).slice(0, 5) : ""].filter(Boolean).join(" ");
  if (item.kind === "booking") return when ? `ยืนยันนัด ${when}` : "ยืนยันนัด";
  if (item.kind === "reschedule") return item.date ? `ขอเลื่อนนัด → ${shortThaiDate(item.date)}` : "ขอเลื่อนนัด";
  if (item.kind === "failed") return "ส่งไม่สำเร็จ";
  if (item.kind === "tasks") return `งานทีม ${item.count ?? 1}`;
  return "AI ตอบแล้ว รอตรวจ";
}

/** งานที่ด่วนสุดของแชท (ป้ายที่แสดง) */
export function topWork(items: WorkItem[] | undefined): WorkItem | null {
  if (!items?.length) return null;
  return [...items].sort((a, b) => WORK_PRIORITY.indexOf(a.kind) - WORK_PRIORITY.indexOf(b.kind))[0];
}

/** เวลาที่งานค้างเกิดก่อนสุด (ใช้เรียงช่วงงานค้าง: เก่าสุดก่อน) */
const workSince = (items: WorkItem[]) => Math.min(...items.map((i) => tsOr(i.since, Infinity)));

export type InboxSection = "waiting" | "work" | "recent";
/** รอตอบ = ข้อความล่าสุดมาจากลูกค้าและยังไม่มีคนตอบ · งานค้าง = ตอบแล้วแต่ยังมีงาน · ที่เหลือ = ล่าสุด (รวมที่เสร็จแล้ว) */
export function sectionOf(c: Pick<InboxRow, "status" | "last_direction">, work: WorkItem[] | undefined): InboxSection {
  if (c.status === "open" && c.last_direction === "in") return "waiting";
  if (work?.length) return "work";
  return "recent";
}

export type InboxFilter = "all" | "waiting" | "work" | "mine";

/**
 * จัดแชทเป็น 3 ช่วง: รอตอบ (รอนานสุดบน) · งานค้าง (งานเก่าสุดก่อน) · ล่าสุด (ข้อความล่าสุดก่อน)
 * filter: ทั้งหมด / รอตอบ / งานค้าง / ของฉัน (มอบหมายให้ฉัน ทั้ง 3 ช่วง)
 */
export function inboxSections<T extends InboxRow & { assigned_to?: string | null }>(rows: T[], work: WorkMap, opts: { filter?: InboxFilter; meId?: string } = {}) {
  const uniq = [...new Map(rows.map((r) => [r.id, r])).values()];
  const mine = opts.filter === "mine" ? uniq.filter((r) => !!opts.meId && r.assigned_to === opts.meId) : uniq;
  const by = (sec: InboxSection) => mine.filter((r) => sectionOf(r, work[r.id]) === sec);
  const waiting = by("waiting").sort((a, b) => tsOr(a.waiting_since ?? a.last_inbound_at, Infinity) - tsOr(b.waiting_since ?? b.last_inbound_at, Infinity));
  const pending = by("work").sort((a, b) => workSince(work[a.id]) - workSince(work[b.id]));
  const recent = by("recent").sort((a, b) => tsOr(b.last_message_at, 0) - tsOr(a.last_message_at, 0));
  if (opts.filter === "waiting") return { waiting, work: [] as T[], recent: [] as T[] };
  if (opts.filter === "work") return { waiting: [] as T[], work: pending, recent: [] as T[] };
  return { waiting, work: pending, recent };
}

// ---------------------------------------------------------------------------
// รายการแชทจาก /api/inbox/list: แต่ละแถวบอกช่วงมาเอง (queue) — หน้าจอจัดกลุ่ม/เรียงเท่านั้น
// ---------------------------------------------------------------------------
export interface QueueRowLike extends InboxRow { queue?: InboxSection | null; work_since?: string | null; assigned_to?: string | null }

/**
 * ช่วงของแถว: รอตอบตัดสินจากแถวเองเสมอ (แก้ในเครื่องแล้วย้ายทันที) · นอกนั้นตาม queue ที่ server คำนวณ
 * (เคยรอตอบ แล้วเพิ่งตอบไป = ล่าสุด จนกว่า server จะบอกว่ามีงานค้าง)
 */
export function queueOf(r: QueueRowLike): InboxSection {
  if (r.status === "open" && r.last_direction === "in") return "waiting";
  return r.queue === "work" ? "work" : "recent";
}

/** จัด 3 ช่วง + เรียงแบบเดียวกับ inboxSections · filter ของฉัน = มอบหมายให้ฉัน */
export function queueSections<T extends QueueRowLike>(rows: T[], opts: { filter?: InboxFilter; meId?: string } = {}) {
  const uniq = [...new Map(rows.map((r) => [r.id, r])).values()];
  const mine = opts.filter === "mine" ? uniq.filter((r) => !!opts.meId && r.assigned_to === opts.meId) : uniq;
  const by = (sec: InboxSection) => mine.filter((r) => queueOf(r) === sec);
  const waiting = by("waiting").sort((a, b) => tsOr(a.waiting_since ?? a.last_inbound_at, Infinity) - tsOr(b.waiting_since ?? b.last_inbound_at, Infinity));
  const work = by("work").sort((a, b) => tsOr(a.work_since, Infinity) - tsOr(b.work_since, Infinity));
  const recent = by("recent").sort((a, b) => tsOr(b.last_message_at, 0) - tsOr(a.last_message_at, 0));
  if (opts.filter === "waiting") return { waiting, work: [] as T[], recent: [] as T[] };
  if (opts.filter === "work") return { waiting: [] as T[], work, recent: [] as T[] };
  return { waiting, work, recent };
}
