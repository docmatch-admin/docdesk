import { NextResponse } from "next/server";
import { labErrorResponse } from "@/lib/lab-http";
import { patientConfirmAppointment } from "@/lib/lab-results-store";

export const runtime = "nodejs";

/** คนไข้ยืนยันนัดฟังผลจากหน้า LIFF: { appointmentId, idToken } */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { appointmentId?: unknown; idToken?: unknown };
  if (typeof b.appointmentId !== "string" || typeof b.idToken !== "string" || !b.idToken || b.idToken.length > 4096) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  try {
    return NextResponse.json(await patientConfirmAppointment(b.appointmentId, b.idToken));
  } catch (e) {
    return labErrorResponse(e, "lab-results:confirm");
  }
}
