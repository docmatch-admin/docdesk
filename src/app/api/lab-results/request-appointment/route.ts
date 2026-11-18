import { NextResponse } from "next/server";
import { labErrorResponse } from "@/lib/lab-http";
import { patientRequestAppointment } from "@/lib/lab-results-store";

export const runtime = "nodejs";

/** คนไข้ขอนัดฟังผล: { id, idToken, date: YYYY-MM-DD, time: HH:mm } → คำขอรอเจ้าหน้าที่ลงนัด */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { id?: unknown; idToken?: unknown; date?: unknown; time?: unknown };
  if (typeof b.id !== "string" || typeof b.idToken !== "string" || !b.idToken || b.idToken.length > 4096) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    return NextResponse.json(await patientRequestAppointment(b.id, b.idToken, b.date, b.time));
  } catch (e) {
    return labErrorResponse(e, "lab-results:request-appointment");
  }
}
