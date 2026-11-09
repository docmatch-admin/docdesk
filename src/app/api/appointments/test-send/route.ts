import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { sendTestAppointment } from "@/lib/appointment-store";

export const runtime = "nodejs";

/** ส่งข้อความนัดตัวอย่างไปแชทที่เลือก (แชทของตัวเอง) { conversation_id } */
export async function POST(req: Request) {
  const { user, error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as { conversation_id?: unknown };
  if (typeof b.conversation_id !== "string" || !b.conversation_id) return NextResponse.json({ error: "เลือกแชทก่อน" }, { status: 400 });
  const result = await sendTestAppointment(b.conversation_id, user.id);
  return NextResponse.json(result, { status: result.sent ? 200 : 409 });
}
