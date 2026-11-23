import { generateTempPassword, setStaffActive } from "./staff-admin";
import { isValidUsername, STAFF_EMAIL_DOMAIN } from "./staff-login";
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
  /** มีเฉพาะ endpoint kpi-ingest (?action=employees) */
  full_name?: string | null;
  email?: string | null;
}

const clean = (v: string | null | undefined) => v?.trim() || null;
const LEFT_STATUSES = ["resigned", "terminated"];

const legacySyncEnabled = () => !!process.env.HR_SYNC_URL && !!process.env.HR_SYNC_SECRET;
/** HR_KPI_URL + HR_KPI_KEY: endpoint เดียวกับที่ส่งคะแนน ใช้อ่านรายชื่อได้ด้วย (?action=employees) */
export const hrKpiEnabled = () => !!process.env.HR_KPI_URL && !!process.env.HR_KPI_KEY;

export function hrSyncEnabled(): boolean {
  return legacySyncEnabled() || hrKpiEnabled();
}

export const hrHasLeft = (e: HrEmployee) => LEFT_STATUSES.includes(clean(e.employment_status)?.toLowerCase() ?? "");

export function hrFullName(e: HrEmployee): string | null {
  return [clean(e.title), clean(e.first_name), clean(e.last_name)].filter(Boolean).join(" ") || clean(e.full_name);
}

/** ไม่มีชื่อเล่นใช้ชื่อจริง ถ้าไม่มีทั้งคู่คืน null เพื่อคงชื่อเดิม */
export const hrDisplayName = (e: HrEmployee) => clean(e.nickname) ?? clean(e.first_name);

/** อ่านรายชื่อจาก HR ถ้าข้อมูลผิดรูปแบบให้ throw ทั้งชุด ไม่ซิงก์ข้อมูลครึ่งเดียว */
export async function fetchHrEmployees(): Promise<HrEmployee[]> {
  const [url, headers]: [string, Record<string, string>] = legacySyncEnabled()
    ? [process.env.HR_SYNC_URL as string, { Authorization: `Bearer ${process.env.HR_SYNC_SECRET}` }]
    : [hrKpiUrl("employees"), { "x-api-key": process.env.HR_KPI_KEY as string }];
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HR ตอบกลับ ${res.status}`);
  const body = (await res.json()) as HrEmployee[] | { employees?: HrEmployee[] };
  const list = Array.isArray(body) ? body : body.employees;
  if (!Array.isArray(list) || list.some((e) => typeof e?.id !== "string" || !e.id)) throw new Error("รูปแบบข้อมูล HR ไม่ถูกต้อง");
  return list;
}

export function hrKpiUrl(action?: string): string {
  const url = new URL(process.env.HR_KPI_URL as string);
  if (action) url.searchParams.set("action", action);
  return url.toString();
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

export interface HrImportResult { created: number; paired: number; skipped: string[] }

/**
 * สร้างบัญชีให้พนักงาน HR ที่ยังไม่มีบัญชี (ข้ามคนที่ลาออกแล้ว) ชื่อผู้ใช้ = รหัสพนักงานตัวพิมพ์เล็ก
 * สิทธิ์เป็น agent เสมอ ไม่ให้ admin อัตโนมัติ รหัสผ่านสุ่มที่ไม่มีใครเห็น ไม่บังคับเปลี่ยนรหัส
 * พนักงานเข้าได้เมื่อ HR ส่ง hash มา (รหัสเดียวกับ HR) ถ้ามีบัญชีที่ชื่อผู้ใช้ตรงกับรหัสพนักงานเป๊ะและยังไม่จับคู่ จะจับคู่ให้
 * ที่สร้างผิดคนลบได้จากหน้าพนักงาน
 */
export async function importHrEmployees(employees: HrEmployee[]): Promise<HrImportResult> {
  const db = supabaseAdmin();
  const { data } = await db.from("staff").select("id, username, hr_employee_id, role");
  const staff = (data ?? []) as { id: string; username: string | null; hr_employee_id: string | null; role?: string }[];
  const result: HrImportResult = { created: 0, paired: 0, skipped: [] };

  for (const e of employees) {
    if (hrHasLeft(e) || staff.some((s) => s.hr_employee_id === e.id)) continue;
    const label = clean(e.employee_code) ?? hrFullName(e) ?? e.id;
    const username = clean(e.employee_code)?.toLowerCase() ?? "";
    if (!isValidUsername(username)) {
      result.skipped.push(`${label}: รหัสพนักงานใช้เป็นชื่อผู้ใช้ไม่ได้`);
      continue;
    }
    const existing = staff.find((s) => s.username === username);
    if (existing) {
      if (existing.role === "admin") {
        result.skipped.push(`${label}: ชื่อผู้ใช้นี้เป็น admin ไม่จับคู่อัตโนมัติ ให้จับคู่เองในหน้าพนักงาน`);
        continue;
      }
      if (existing.hr_employee_id) {
        result.skipped.push(`${label}: ชื่อผู้ใช้นี้จับคู่กับพนักงานคนอื่นแล้ว`);
        continue;
      }
      const { error } = await db.from("staff").update({ hr_employee_id: e.id, must_change_password: false }).eq("id", existing.id);
      if (error) { result.skipped.push(`${label}: จับคู่ไม่สำเร็จ`); continue; }
      existing.hr_employee_id = e.id;
      result.paired++;
      continue;
    }
    const { data: created, error: createError } = await db.auth.admin.createUser({
      email: `${username}@${STAFF_EMAIL_DOMAIN}`, password: generateTempPassword(16), email_confirm: true,
    });
    if (createError || !created.user) { result.skipped.push(`${label}: สร้างบัญชีไม่สำเร็จ`); continue; }
    const { error: insertError } = await db.from("staff").insert({
      id: created.user.id, display_name: hrDisplayName(e) ?? hrFullName(e) ?? username, role: "agent",
      username, must_change_password: false, hr_employee_id: e.id,
    });
    if (insertError) {
      await db.auth.admin.deleteUser(created.user.id);
      result.skipped.push(`${label}: สร้างบัญชีไม่สำเร็จ`);
      continue;
    }
    staff.push({ id: created.user.id, username, hr_employee_id: e.id });
    result.created++;
  }
  return result;
}
