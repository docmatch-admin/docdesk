import { NextResponse } from "next/server";
import { logSystemError } from "@/lib/health";
import { applyHrCredential, parseCredentialPush, secretMatches } from "@/lib/hr-credentials";

export const runtime = "nodejs";

/**
 * HR เรียกเมื่อพนักงานตั้งหรือเปลี่ยนรหัสผ่าน: { hr_employee_id, password_hash(bcrypt) }
 * ใช้ Authorization: Bearer HR_CREDENTIAL_SECRET ห้ามส่งรหัสผ่านจริง
 */
export async function POST(req: Request) {
  if (!secretMatches(req.headers.get("authorization"), process.env.HR_CREDENTIAL_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const push = parseCredentialPush(await req.json().catch(() => null));
  if (!push) return NextResponse.json({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, { status: 400 });
  try {
    const result = await applyHrCredential(push);
    if (result === "failed") throw new Error("ตั้งรหัสผ่านไม่สำเร็จ");
    // ไม่ใส่ hash หรือชื่อบัญชีลง log
    return NextResponse.json({ result }, { status: result === "updated" ? 200 : result === "unmatched" ? 404 : 409 });
  } catch (e) {
    await logSystemError("api:hr-credentials", e);
    return NextResponse.json({ error: "ตั้งรหัสผ่านไม่สำเร็จ" }, { status: 500 });
  }
}
