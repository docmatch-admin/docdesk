import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { addDays, parseDate } from "@/lib/appointment-rules";
import { appointmentDayCounts } from "@/lib/appointment-store";

export const runtime = "nodejs";

/** ?from=&to= จำนวนนัดต่อวันและต่อช่วง ใช้ในปฏิทินของฟอร์มนัด (สูงสุด 62 วันต่อครั้ง) */
export async function GET(req: Request) {
  const { error } = await requireAppointmentStaff();
  if (error) return error;
  const u = new URL(req.url);
  const from = parseDate(u.searchParams.get("from"));
  const to = parseDate(u.searchParams.get("to"));
  if (!from || !to || to < from || to > addDays(from, 62)) return NextResponse.json({ error: "ช่วงวันที่ไม่ถูกต้อง" }, { status: 400 });
  return NextResponse.json({ counts: await appointmentDayCounts(from, to) }, { headers: { "Cache-Control": "no-store" } });
}
