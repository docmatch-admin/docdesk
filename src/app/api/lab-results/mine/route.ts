import { NextResponse } from "next/server";
import { labErrorResponse } from "@/lib/lab-http";
import { patientLabList } from "@/lib/lab-results-store";

export const runtime = "nodejs";

/** หน้า LIFF "ผลแล็บของฉัน": { idToken } → ผลทุกรายการของ HN ที่บัญชี LINE นี้ผูก (ไม่มีลิงก์ไฟล์ เปิดทีละรายการผ่าน /view) */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { idToken?: unknown };
  if (typeof b.idToken !== "string" || !b.idToken || b.idToken.length > 4096) return NextResponse.json({ error: "bad request" }, { status: 400 });
  try {
    return NextResponse.json(await patientLabList(b.idToken), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return labErrorResponse(e, "lab-results:mine");
  }
}
