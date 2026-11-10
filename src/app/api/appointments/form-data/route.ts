import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { appointmentFormData } from "@/lib/appointment-store";

export const runtime = "nodejs";

/** ?hn=&provider= ช่วยกรอกฟอร์มนัด และบอกว่า HN นี้มีแชทแล้วหรือยัง */
export async function GET(req: Request) {
  const { error } = await requireAppointmentStaff();
  if (error) return error;
  const q = new URL(req.url).searchParams;
  const hn = q.get("hn")?.trim().slice(0, 30) || null;
  // ผู้นัดของนัดที่กำลังแก้ ให้อยู่ในตัวเลือกแม้ถูกซ่อนแล้ว
  const provider = q.get("provider")?.trim().slice(0, 120) || null;
  return NextResponse.json(await appointmentFormData(hn, Date.now(), provider), { headers: { "Cache-Control": "no-store" } });
}
