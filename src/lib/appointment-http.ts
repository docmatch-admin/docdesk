import { NextResponse } from "next/server";
import { AppointmentError } from "./appointment-store";

/** แปลง error ของระบบนัดเป็นคำตอบ API ไม่ส่งรายละเอียดของฐานข้อมูลออกไป */
export function appointmentErrorResponse(e: unknown) {
  if (e instanceof AppointmentError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("appointment api failed", e instanceof Error ? e.message : e);
  return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
}
