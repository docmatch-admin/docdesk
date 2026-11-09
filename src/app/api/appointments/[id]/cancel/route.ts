import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { appointmentErrorResponse } from "@/lib/appointment-http";
import { cancelAppointment } from "@/lib/appointment-store";

export const runtime = "nodejs";

/** ยกเลิกนัด { reason: patient|doctor|mistake|other, reason_text? } ส่งข้อความแจ้งยกเลิกถ้ามีแชท ยกเว้นลงนัดผิด */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAppointmentStaff();
  if (error) return error;
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as { reason?: unknown; reason_text?: unknown };
  try {
    return NextResponse.json(await cancelAppointment(id, user.id, { code: b.reason, text: b.reason_text }));
  } catch (e) {
    return appointmentErrorResponse(e);
  }
}
