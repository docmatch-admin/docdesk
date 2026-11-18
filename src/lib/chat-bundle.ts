"use client";

/**
 * ข้อมูลทั้งห้องแชทตอนเปิด (GET /api/conversations/[id]) — ห้องแชทและกล่องข้าง ๆ ทุกกล่องใช้ request เดียวกัน
 * ส่วนไหนเป็น null = server โหลดไม่สำเร็จ → กล่องนั้นโหลดเองตามเดิม
 * การโหลดซ้ำภายหลัง (realtime / หลังแก้ข้อมูล) แต่ละกล่องยังเรียก endpoint ของตัวเอง
 */
export interface ChatBundle {
  conv: { sensitive: boolean; archived: boolean };
  messages: unknown[] | null;
  bookings: unknown[] | null;
  /** undefined = โหลดไม่สำเร็จ · null = ยังไม่มีคำแนะนำ */
  suggestion?: { id: string; options: unknown; needs_human: boolean; suggested_tags: unknown } | null;
  history: unknown[] | null;
  tasks: unknown[] | null;
  notes: unknown[] | null;
  tagSources: Record<string, string> | null;
  archive: unknown[] | null;
  appointments: { groups: unknown[] } | null;
  labResults: unknown[] | null;
}

/** กล่องต่าง ๆ mount พร้อมกันตอนเปิดแชท: ใช้ผลเดียวกันภายในช่วงนี้ */
const SHARE_MS = 3_000;
const cache = new Map<string, { at: number; p: Promise<ChatBundle | null> }>();

export function chatBundle(id: string): Promise<ChatBundle | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < SHARE_MS) return hit.p;
  const p = fetch(`/api/conversations/${id}`)
    .then((r) => (r.ok ? (r.json() as Promise<ChatBundle>) : null))
    .catch(() => null);
  cache.set(id, { at: Date.now(), p });
  for (const [k, v] of cache) if (Date.now() - v.at > SHARE_MS) cache.delete(k);
  return p;
}

/** ข้อมูลเปลี่ยนจากการกระทำในเครื่องนี้ (เช่น แยก/รวมประวัติ) → ครั้งหน้าต้องโหลดใหม่ */
export function forgetChatBundle(id: string) {
  cache.delete(id);
}
