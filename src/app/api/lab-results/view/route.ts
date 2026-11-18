import { NextResponse } from "next/server";
import { labErrorResponse } from "@/lib/lab-http";
import { patientViewLab } from "@/lib/lab-results-store";

export const runtime = "nodejs";

/** คนไข้เปิดผลผ่าน LIFF: { id, idToken } → ยืนยันว่า LINE userId ผูกกับ HN ของผลนี้ → signed URL อายุ ≤ 10 นาที */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { id?: unknown; idToken?: unknown };
  if (typeof b.id !== "string" || typeof b.idToken !== "string" || !b.idToken || b.idToken.length > 4096) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    return NextResponse.json(await patientViewLab(b.id, b.idToken), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return labErrorResponse(e, "lab-results:view");
  }
}
