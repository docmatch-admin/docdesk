import { NextResponse } from "next/server";
import { labErrorResponse } from "@/lib/lab-http";
import { patientBookingInfo } from "@/lib/lab-results-store";

export const runtime = "nodejs";

/** หน้า LIFF เลือกวันนัดฟังผล: { id, idToken } → วัน/เวลาที่เลือกได้ + นัดหรือคำขอที่มีอยู่แล้ว */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { id?: unknown; idToken?: unknown };
  if (typeof b.id !== "string" || typeof b.idToken !== "string" || !b.idToken || b.idToken.length > 4096) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    return NextResponse.json(await patientBookingInfo(b.id, b.idToken), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return labErrorResponse(e, "lab-results:booking");
  }
}
