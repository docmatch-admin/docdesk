/** แท็กนี้หมดความหมายเมื่อลูกค้าทักกลับมาหลังกดเสร็จแล้ว แท็กอื่นเก็บไว้ */
export const CLEARED_ON_REOPEN_TAG = "นัดแล้ว";

/** แชทถัดไปที่เปิดอยู่ตามลำดับรายการ ถึงท้ายรายการแล้ววนกลับต้นรายการ */
export function nextOpenChat<T extends { id: string; status: string }>(list: T[], currentId: string): string | null {
  const at = list.findIndex((c) => c.id === currentId);
  const ordered = at === -1 ? list : [...list.slice(at + 1), ...list.slice(0, at)];
  return ordered.find((c) => c.status === "open" && c.id !== currentId)?.id ?? null;
}

export function isWaitingForReply(c: { status: string; last_direction: string | null }): boolean {
  return c.status === "open" && c.last_direction === "in";
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
