import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { rescheduleText } from "@/lib/booking-rules";
import { loadBookingTemplates, loadBusinessHours } from "@/lib/booking-store";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** ข้อความขอเลื่อนสำหรับใส่ช่องพิมพ์ ไม่ส่งเอง และยังไม่เปลี่ยนสถานะนัดจนกว่าเจ้าหน้าที่จะกดส่ง */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const { data: owner } = await supabaseAdmin().from("bookings").select("conversation_id").eq("id", id).maybeSingle();
  if (owner) {
    const denied = await denySensitiveChat(owner.conversation_id as string, canViewSensitive);
    if (denied) return denied;
  }
  const { data } = await supabaseAdmin().from("bookings").select('service, "date", "time"').eq("id", id).maybeSingle();
  if (!data) return NextResponse.json({ error: "ไม่พบนัด" }, { status: 404 });
  const [templates, hours] = await Promise.all([loadBookingTemplates(), loadBusinessHours()]);
  return NextResponse.json({
    text: rescheduleText(data as unknown as { service: string; date: string; time: string }, templates, hours, Date.now()),
  });
}
