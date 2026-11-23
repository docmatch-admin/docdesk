import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { sendPushToStaff } from "@/lib/booking-store";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** ปุ่ม "ทดสอบแจ้งเตือน": ส่งไปเครื่องที่กดเท่านั้น (ต้องเป็นเครื่องของบัญชีนี้) */
export async function POST(req: Request) {
  const { user, error } = await requireAppointmentStaff();
  if (error) return error;
  const { endpoint } = (await req.json().catch(() => ({}))) as { endpoint?: unknown };
  if (typeof endpoint !== "string") return NextResponse.json({ error: "ไม่พบเครื่องนี้" }, { status: 400 });
  const { data } = await supabaseAdmin().from("push_subscriptions").select("endpoint").eq("endpoint", endpoint).eq("staff_id", user.id).maybeSingle();
  if (!data) return NextResponse.json({ error: "เครื่องนี้ยังไม่ได้เปิดแจ้งเตือน" }, { status: 404 });
  const sent = await sendPushToStaff([user.id], { title: "DocDesk", body: "ทดสอบแจ้งเตือน ✓ เครื่องนี้รับแจ้งเตือนได้แล้ว", url: "/inbox" }, undefined, { endpoint, tag: "docdesk-test" });
  if (!sent) return NextResponse.json({ error: "ส่งไม่สำเร็จ ลองปิดแล้วเปิดแจ้งเตือนใหม่" }, { status: 502 });
  return NextResponse.json({ ok: true });
}
