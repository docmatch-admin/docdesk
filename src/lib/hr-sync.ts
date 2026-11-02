import { setStaffActive } from "./staff-admin";
import { staffChangeError, type StaffRow } from "./staff-rules";
import { supabaseAdmin } from "./supabase/admin";

export interface HrEmployee {
  id: string;
  employee_code: string | null;
  title: string | null;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  position: string | null;
  employment_status: string | null;
}

const clean = (v: string | null | undefined) => v?.trim() || null;
const LEFT_STATUSES = ["resigned", "terminated"];

export function hrSyncEnabled(): boolean {
  return !!process.env.HR_SYNC_URL && !!process.env.HR_SYNC_SECRET;
}

export const hrHasLeft = (e: HrEmployee) => LEFT_STATUSES.includes(clean(e.employment_status)?.toLowerCase() ?? "");

export function hrFullName(e: HrEmployee): string | null {
  return [clean(e.title), clean(e.first_name), clean(e.last_name)].filter(Boolean).join(" ") || null;
}

/** ไม่มีชื่อเล่นใช้ชื่อจริง ถ้าไม่มีทั้งคู่คืน null เพื่อคงชื่อเดิม */
export const hrDisplayName = (e: HrEmployee) => clean(e.nickname) ?? clean(e.first_name);

/** อ่านรายชื่อจาก HR ถ้าข้อมูลผิดรูปแบบให้ throw ทั้งชุด ไม่ซิงก์ข้อมูลครึ่งเดียว */
export async function fetchHrEmployees(): Promise<HrEmployee[]> {
  const res = await fetch(process.env.HR_SYNC_URL as string, {
    headers: { Authorization: `Bearer ${process.env.HR_SYNC_SECRET}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HR ตอบกลับ ${res.status}`);
  const body = (await res.json()) as HrEmployee[] | { employees?: HrEmployee[] };
  const list = Array.isArray(body) ? body : body.employees;
  if (!Array.isArray(list) || list.some((e) => typeof e?.id !== "string" || !e.id)) throw new Error("รูปแบบข้อมูล HR ไม่ถูกต้อง");
  return list;
}

export interface HrSyncResult { updated: number; deactivated: number; unmatched: number; skipped: string[] }

/**
 * อัปเดตเฉพาะบัญชีที่จับคู่ไว้ พนักงานที่ไม่ได้จับคู่ไม่ถูกสร้างบัญชีให้
 * ไม่เปิดบัญชีคืนอัตโนมัติ และไม่ปิดบัญชีถ้าผิดกฎ เช่น เป็น admin คนสุดท้าย
 */
export async function applyHrSync(employees: HrEmployee[], actorId: string): Promise<HrSyncResult> {
  const db = supabaseAdmin();
  const { data } = await db.from("staff").select("id, role, active, hr_employee_id, display_name");
  const staff = (data ?? []) as (StaffRow & { hr_employee_id: string | null; display_name: string })[];
  const result: HrSyncResult = { updated: 0, deactivated: 0, unmatched: 0, skipped: [] };

  for (const employee of employees) {
    const account = staff.find((s) => s.hr_employee_id === employee.id);
    if (!account) {
      result.unmatched++;
      continue;
    }
    const name = hrDisplayName(employee);
    const { error } = await db.from("staff").update({
      full_name: hrFullName(employee),
      position: clean(employee.position),
      ...(name ? { display_name: name } : {}),
    }).eq("id", account.id);
    if (error) {
      result.skipped.push(`${account.display_name}: บันทึกไม่สำเร็จ`);
      continue;
    }
    result.updated++;

    if (hrHasLeft(employee) && account.active) {
      const problem = staffChangeError(actorId, account, { active: false }, staff);
      const failure = problem ?? (await setStaffActive(account.id, false, actorId));
      if (failure) {
        result.skipped.push(`${name ?? account.display_name}: ${failure}`);
        continue;
      }
      account.active = false;
      result.deactivated++;
    }
  }
  return result;
}
