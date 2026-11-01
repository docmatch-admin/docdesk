/** แท็กนี้หมดความหมายเมื่อลูกค้าทักกลับมาหลังปิดเคส แท็กอื่นเก็บไว้ */
export const CLEARED_ON_REOPEN_TAG = "นัดแล้ว";

/** แชทถัดไปที่เปิดอยู่ตามลำดับรายการ ถึงท้ายรายการแล้ววนกลับต้นรายการ */
export function nextOpenChat<T extends { id: string; status: string }>(list: T[], currentId: string): string | null {
  const at = list.findIndex((c) => c.id === currentId);
  const ordered = at === -1 ? list : [...list.slice(at + 1), ...list.slice(0, at)];
  return ordered.find((c) => c.status === "open" && c.id !== currentId)?.id ?? null;
}
