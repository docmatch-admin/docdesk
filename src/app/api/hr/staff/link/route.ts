import { NextResponse } from "next/server";
import { logSystemError } from "@/lib/health";
import { secretMatches } from "@/lib/hr-credentials";
import { linkHrEmployee } from "@/lib/hr-staff-link";

export const runtime = "nodejs";

/**
 * HR เชื่อม/เลิกเชื่อมพนักงานกับบัญชี DocDesk: POST { hr_employee_id, staff_id | null }
 * เชื่อมแล้ว HR ส่งรหัสผ่าน (hash) มาที่ /api/hr/credentials ตามปกติ
 */
export async function POST(req: Request) {
  if (!secretMatches(req.headers.get("authorization"), process.env.HR_CREDENTIAL_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const b = (await req.json().catch(() => null)) as { hr_employee_id?: unknown; staff_id?: unknown } | null;
  if (!b || !("staff_id" in b)) return NextResponse.json({ error: "ต้องมี hr_employee_id และ staff_id" }, { status: 400 });
  try {
    const r = await linkHrEmployee(b.hr_employee_id, b.staff_id ?? null);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, staff_id: r.staff_id });
  } catch (e) {
    await logSystemError("api:hr-staff-link", e);
    return NextResponse.json({ error: "เชื่อมบัญชีไม่สำเร็จ" }, { status: 500 });
  }
}
