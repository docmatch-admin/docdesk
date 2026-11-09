/**
 * ตารางเวลาเปิดคลินิกแบบยุบแถว: จันทร์–ศุกร์ / เสาร์ / อาทิตย์
 * ฐานข้อมูลยังเก็บรายวันเหมือนเดิม (clinic_hours: weekday 0–6) แถวกลุ่มแก้ทุกวันในกลุ่มพร้อมกัน
 */
export interface HourSlot { weekday: number; slot_id: string; label: string; start_time: string; end_time: string; sort_order: number }

export const DAY_NAME = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
/** เรียงวันเริ่มจันทร์ */
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface HourGroup { key: string; label: string; days: number[] }
export const HOUR_GROUPS: HourGroup[] = [
  { key: "weekday", label: "จันทร์–ศุกร์", days: [1, 2, 3, 4, 5] },
  { key: "sat", label: "เสาร์", days: [6] },
  { key: "sun", label: "อาทิตย์", days: [0] },
];

/** ช่วงเวลาของวันเดียว เรียงตามเวลาเริ่ม */
export function slotsOfDay<T extends HourSlot>(slots: T[], day: number): T[] {
  return slots.filter((s) => s.weekday === day).sort((a, b) => a.start_time.localeCompare(b.start_time) || a.slot_id.localeCompare(b.slot_id));
}

/** ลายเซ็นของวัน (ไม่สนลำดับในอาร์เรย์และ weekday) ใช้เทียบว่าสองวันตั้งเหมือนกันไหม */
export function daySignature(slots: HourSlot[], day: number): string {
  return JSON.stringify(slotsOfDay(slots, day).map((s) => [s.slot_id, s.label.trim(), s.start_time.slice(0, 5), s.end_time.slice(0, 5)]));
}

/** จันทร์–ศุกร์ตั้งเวลาเหมือนกันทุกวันหรือไม่ (ไม่เหมือน = ต้องแสดงรายวัน ห้ามยุบทับค่า) */
export function weekdaysUniform(slots: HourSlot[]): boolean {
  const first = daySignature(slots, 1);
  return [2, 3, 4, 5].every((d) => daySignature(slots, d) === first);
}

/** ลายเซ็นทั้งตาราง สำหรับเทียบ "มีการแก้ไขที่ยังไม่บันทึก" */
export function hoursSignature(slots: HourSlot[]): string {
  return JSON.stringify(DAY_ORDER.map((d) => daySignature(slots, d)));
}

/** แก้ช่วงเวลาเดียวกัน (slot_id) ในทุกวันของกลุ่ม */
export function patchGroupSlot<T extends HourSlot>(slots: T[], days: number[], slotId: string, patch: Partial<HourSlot>): T[] {
  return slots.map((s) => (days.includes(s.weekday) && s.slot_id === slotId ? { ...s, ...patch } : s));
}

export function removeGroupSlot<T extends HourSlot>(slots: T[], days: number[], slotId: string): T[] {
  return slots.filter((s) => !(days.includes(s.weekday) && s.slot_id === slotId));
}

/** ช่วงถัดไปที่ควรเพิ่ม: เช้า → บ่าย → เย็น */
export function nextSlotPreset(used: Set<string>) {
  if (!used.has("morning")) return { slot_id: "morning", label: "ช่วงเช้า", start_time: "08:00", end_time: "12:00" };
  if (!used.has("afternoon")) return { slot_id: "afternoon", label: "ช่วงบ่าย", start_time: "13:00", end_time: "18:00" };
  let n = used.size + 1;
  while (used.has(`slot${n}`)) n++;
  return { slot_id: `slot${n}`, label: "ช่วงเย็น", start_time: "18:00", end_time: "20:00" };
}

/** เพิ่มช่วงให้ทุกวันในกลุ่ม (ใช้รหัสเดียวกันเพื่อให้แก้พร้อมกันได้) */
export function addGroupSlot(slots: HourSlot[], days: number[]): HourSlot[] {
  const used = new Set(slots.filter((s) => days.includes(s.weekday)).map((s) => s.slot_id));
  const preset = nextSlotPreset(used);
  return [...slots, ...days.map((d) => ({ weekday: d, sort_order: (slotsOfDay(slots, d).length + 1) * 10, ...preset }))];
}

/** ตรวจก่อนบันทึก คืนข้อความ error หรือ null */
export function validateHours(slots: HourSlot[]): string | null {
  const bad = slots.find((s) => !s.label.trim() || !/^[a-z0-9_-]{1,30}$/.test(s.slot_id) || s.end_time <= s.start_time);
  if (bad) return `${DAY_NAME[bad.weekday]}: ช่วงเวลาไม่ถูกต้อง (เวลาสิ้นสุดต้องหลังเวลาเริ่ม)`;
  const dup = slots.find((s, i) => slots.findIndex((x) => x.weekday === s.weekday && x.slot_id === s.slot_id) !== i);
  if (dup) return `${DAY_NAME[dup.weekday]}: รหัสช่วง ${dup.slot_id} ซ้ำ`;
  return null;
}
