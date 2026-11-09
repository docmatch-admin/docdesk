import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { appointmentFormData } from "@/lib/appointment-store";

export const runtime = "nodejs";

/** ?hn= ช่วยกรอกฟอร์มนัด และบอกว่า HN นี้มีแชทแล้วหรือยัง */
export async function GET(req: Request) {
  const { error } = await requireAppointmentStaff();
  if (error) return error;
  const hn = new URL(req.url).searchParams.get("hn")?.trim().slice(0, 30) || null;
  return NextResponse.json(await appointmentFormData(hn), { headers: { "Cache-Control": "no-store" } });
}
