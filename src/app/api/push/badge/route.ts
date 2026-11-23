import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { unreadChatCounts } from "@/lib/push-store";

export const runtime = "nodejs";

/** ตัวเลขบนไอคอนแอป = แชทที่ยังไม่อ่าน (คนไม่มีสิทธิ์แชทลับไม่นับแชทลับ · ห้องยา = 0) */
export async function GET() {
  const { role, canViewSensitive, error } = await requireAppointmentStaff();
  if (error) return error;
  if (role === "pharmacy") return NextResponse.json({ count: 0 });
  const c = await unreadChatCounts();
  return NextResponse.json({ count: canViewSensitive ? c.all : c.nonSensitive });
}
