import { NextResponse } from "next/server";
import { logSystemError } from "@/lib/health";
import { secretMatches } from "@/lib/hr-credentials";
import { hrStaffList } from "@/lib/hr-staff-link";

export const runtime = "nodejs";

/** HR ดูบัญชีเจ้าหน้าที่ DocDesk เพื่อเชื่อมกับพนักงาน: Authorization: Bearer HR_CREDENTIAL_SECRET */
export async function GET(req: Request) {
  if (!secretMatches(req.headers.get("authorization"), process.env.HR_CREDENTIAL_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ staff: await hrStaffList() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    await logSystemError("api:hr-staff", e);
    return NextResponse.json({ error: "อ่านบัญชีเจ้าหน้าที่ไม่สำเร็จ" }, { status: 500 });
  }
}
