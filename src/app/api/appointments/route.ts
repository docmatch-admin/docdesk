import { NextResponse } from "next/server";
import { denySensitiveChat, requireAppointmentStaff } from "@/lib/auth";
import { appointmentErrorResponse } from "@/lib/appointment-http";
import { appointmentCallCounts, createAppointment, listAppointments } from "@/lib/appointment-store";
import { parseDate } from "@/lib/appointment-rules";

export const runtime = "nodejs";

/** หน้านัดหมาย: ?tab=today|tomorrow|all&q=&from=&to= */
export async function GET(req: Request) {
  const { error } = await requireAppointmentStaff();
  if (error) return error;
  const u = new URL(req.url);
  if (u.searchParams.get("counts")) return NextResponse.json({ counts: await appointmentCallCounts() }, { headers: { "Cache-Control": "no-store" } });
  const tab = u.searchParams.get("tab");
  const rows = await listAppointments({
    tab: tab === "today" || tab === "all" ? tab : "tomorrow",
    q: u.searchParams.get("q") ?? "",
    from: parseDate(u.searchParams.get("from")),
    to: parseDate(u.searchParams.get("to")),
  });
  return NextResponse.json({ rows, counts: await appointmentCallCounts() }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * ลงนัด: { hn?, patient_name, phone?, appoint_date, appoint_time, purpose?, provider?, note?, conversation_id?, booking_id? }
 * ทำนัดจากแชท (มี conversation_id) ต้องเป็นเจ้าหน้าที่ที่อ่านแชทนั้นได้ ห้องยาทำนัดจากหน้านัดหมายเท่านั้น
 */
export async function POST(req: Request) {
  const { user, role, canViewSensitive, error } = await requireAppointmentStaff();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (b.conversation_id || b.booking_id) {
    if (role === "pharmacy") return NextResponse.json({ error: "forbidden" }, { status: 403 });
    if (typeof b.conversation_id === "string") {
      const denied = await denySensitiveChat(b.conversation_id, canViewSensitive);
      if (denied) return denied;
    }
  }
  try {
    return NextResponse.json(await createAppointment(b, user.id, { canLink: role === "admin" }));
  } catch (e) {
    return appointmentErrorResponse(e);
  }
}
