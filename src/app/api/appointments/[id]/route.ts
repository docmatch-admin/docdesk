import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { appointmentErrorResponse } from "@/lib/appointment-http";
import { appointmentEvents, appointmentSlip, setCalled, updateAppointment } from "@/lib/appointment-store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** รายละเอียดนัด ข้อมูลใบนัด และประวัติ */
export async function GET(_req: Request, { params }: Ctx) {
  const { error } = await requireAppointmentStaff();
  if (error) return error;
  const { id } = await params;
  const slip = await appointmentSlip(id);
  if (!slip) return NextResponse.json({ error: "ไม่พบนัด" }, { status: 404 });
  return NextResponse.json({ ...slip, events: await appointmentEvents(id) }, { headers: { "Cache-Control": "no-store" } });
}

/** { called: boolean } ติ๊กโทรแล้ว หรือแก้รายละเอียด (แก้วัน-เวลาแล้วส่งข้อความนัดใหม่อัตโนมัติ) */
export async function PATCH(req: Request, { params }: Ctx) {
  const { user, error } = await requireAppointmentStaff();
  if (error) return error;
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (typeof b.called === "boolean") {
      await setCalled(id, b.called, user.id);
      return NextResponse.json({ ok: true });
    }
    // แชทและ booking ผูกตอนสร้างหรือจากรหัสเท่านั้น
    const fields = { ...b };
    delete fields.conversation_id;
    delete fields.booking_id;
    return NextResponse.json(await updateAppointment(id, fields, user.id));
  } catch (e) {
    return appointmentErrorResponse(e);
  }
}
