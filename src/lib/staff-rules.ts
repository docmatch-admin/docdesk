export interface StaffRow { id: string; role: string; active: boolean }
export interface StaffPatch { role?: string; active?: boolean; display_name?: string }

/** เหตุผลที่แก้บัญชีนี้ไม่ได้ null = แก้ได้ กันระบบเหลือ admin ศูนย์คน ซึ่งจะกู้ได้จากฐานข้อมูลเท่านั้น */
export function staffChangeError(actorId: string, target: StaffRow, patch: StaffPatch, staff: StaffRow[]): string | null {
  if (patch.role !== undefined && patch.role !== "admin" && patch.role !== "agent") return "role ไม่ถูกต้อง";
  if (patch.display_name !== undefined && !patch.display_name.trim()) return "ต้องมีชื่อ";
  if (target.id === actorId && patch.active === false) return "ปิดบัญชีตัวเองไม่ได้";
  if (target.id === actorId && patch.role === "agent") return "ลดสิทธิ์ตัวเองไม่ได้";

  const losesAdmin = target.role === "admin" && target.active && (patch.active === false || patch.role === "agent");
  const otherAdmins = staff.filter((s) => s.id !== target.id && s.role === "admin" && s.active).length;
  if (losesAdmin && otherAdmins === 0) return "ต้องเหลือ admin อย่างน้อย 1 คน";
  return null;
}
