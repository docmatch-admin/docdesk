import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { appointmentErrorResponse } from "@/lib/appointment-http";
import { restoreAppointment } from "@/lib/appointment-store";

export const runtime = "nodejs";

/** กู้คืนนัดที่ยกเลิกภายในวันเดียวกัน */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAppointmentStaff();
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await restoreAppointment(id, user.id));
  } catch (e) {
    return appointmentErrorResponse(e);
  }
}
