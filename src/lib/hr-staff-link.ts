// HR เชื่อมพนักงานกับบัญชีเจ้าหน้าที่ DocDesk จากหน้าพนักงานของ HR (GET /api/hr/staff, POST /api/hr/staff/link)
import { supabaseAdmin } from "./supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HrStaffRow { id: string; username: string | null; display_name: string | null; role: string; active: boolean; hr_employee_id: string | null }

/** บัญชีเจ้าหน้าที่ทั้งหมด (ไม่มีอีเมล/รหัส) เรียงตามชื่อ */
export async function hrStaffList(): Promise<HrStaffRow[]> {
  const { data, error } = await supabaseAdmin().from("staff").select("id, username, display_name, role, active, hr_employee_id");
  if (error) throw error;
  return ((data ?? []) as HrStaffRow[])
    .map((r) => ({ id: r.id, username: r.username, display_name: r.display_name, role: r.role, active: r.active, hr_employee_id: r.hr_employee_id }))
    .sort((a, b) => (a.display_name ?? a.username ?? "").localeCompare(b.display_name ?? b.username ?? "", "th"));
}

export type LinkResult = { ok: true; staff_id: string | null } | { ok: false; status: number; error: string };

/**
 * ผูกพนักงาน HR 1 คนกับบัญชี DocDesk 1 บัญชี (staff_id = null = เลิกผูก)
 * บัญชีอื่นที่เคยผูกกับพนักงานคนนี้จะถูกเลิกผูกก่อน · ผูกแล้วไม่ต้องเปลี่ยนรหัส (รหัสมาจาก HR)
 */
export async function linkHrEmployee(hrEmployeeId: unknown, staffId: unknown): Promise<LinkResult> {
  if (typeof hrEmployeeId !== "string" || !UUID.test(hrEmployeeId)) return { ok: false, status: 400, error: "hr_employee_id ไม่ถูกต้อง" };
  if (staffId !== null && (typeof staffId !== "string" || !UUID.test(staffId))) return { ok: false, status: 400, error: "staff_id ไม่ถูกต้อง" };
  const db = supabaseAdmin();
  if (staffId) {
    const { data: target } = await db.from("staff").select("id, hr_employee_id").eq("id", staffId).maybeSingle();
    if (!target) return { ok: false, status: 404, error: "ไม่พบบัญชี DocDesk" };
    const t = target as { hr_employee_id: string | null };
    if (t.hr_employee_id && t.hr_employee_id !== hrEmployeeId) return { ok: false, status: 409, error: "บัญชีนี้เชื่อมกับพนักงาน HR คนอื่นอยู่แล้ว" };
  }
  const { error: unlinkError } = await db.from("staff").update({ hr_employee_id: null }).eq("hr_employee_id", hrEmployeeId);
  if (unlinkError) return { ok: false, status: 500, error: "เลิกเชื่อมบัญชีเดิมไม่สำเร็จ" };
  if (!staffId) return { ok: true, staff_id: null };
  const { error } = await db.from("staff").update({ hr_employee_id: hrEmployeeId, must_change_password: false }).eq("id", staffId);
  if (error) return { ok: false, status: error.code === "23505" ? 409 : 500, error: "เชื่อมบัญชีไม่สำเร็จ" };
  return { ok: true, staff_id: staffId };
}
