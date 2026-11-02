import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { applyHrSync, fetchHrEmployees, hrFullName, hrSyncEnabled } from "@/lib/hr-sync";

export const runtime = "nodejs";

const notConfigured = () => NextResponse.json({ error: "ยังไม่ได้ตั้งค่าการเชื่อม HR" }, { status: 404 });

/** รายชื่อสำหรับ dropdown จับคู่ */
export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  if (!hrSyncEnabled()) return notConfigured();
  try {
    const employees = await fetchHrEmployees();
    return NextResponse.json({
      employees: employees.map((e) => ({
        id: e.id, employee_code: e.employee_code, name: hrFullName(e) ?? e.id, employment_status: e.employment_status,
      })),
    });
  } catch (err) {
    console.error("อ่านข้อมูล HR ไม่สำเร็จ", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "อ่านข้อมูล HR ไม่สำเร็จ" }, { status: 502 });
  }
}

export async function POST() {
  const { user, error } = await requireAdmin();
  if (error) return error;
  if (!hrSyncEnabled()) return notConfigured();
  try {
    return NextResponse.json(await applyHrSync(await fetchHrEmployees(), user.id));
  } catch (err) {
    console.error("ซิงก์ HR ไม่สำเร็จ", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "ซิงก์ HR ไม่สำเร็จ" }, { status: 502 });
  }
}
