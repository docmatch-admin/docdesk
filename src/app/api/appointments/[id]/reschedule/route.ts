import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { appointmentErrorResponse } from "@/lib/appointment-http";
import { approveRescheduleRequest, dismissRescheduleRequest } from "@/lib/appointment-store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** { action: "approve" } ใช้วันที่คนไข้เลือก (ส่งข้อความวันนัดใหม่ให้คนไข้) · { action: "dismiss" } จะโทรคุยเอง */
export async function POST(req: Request, { params }: Ctx) {
  const { user, error } = await requireAppointmentStaff();
  if (error) return error;
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as { action?: string };
  try {
    if (b.action === "approve") return NextResponse.json(await approveRescheduleRequest(id, user.id));
    if (b.action === "dismiss") {
      await dismissRescheduleRequest(id, user.id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "action ไม่ถูกต้อง" }, { status: 400 });
  } catch (e) {
    return appointmentErrorResponse(e);
  }
}
