import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * เครื่องนี้สมัครรับแจ้งเตือน (เรียกซ้ำทุกครั้งที่เปิดแอป = อัปเดตเวลาใช้งานล่าสุด/ย้ายไปบัญชีที่ล็อกอินอยู่)
 * endpoint ต้องเป็น https ของ push service · หนึ่งคนมีได้หลายเครื่อง (endpoint ละแถว) · ห้องยาสมัครได้ (รับแจ้งเตือนนัด)
 */
export async function POST(req: Request) {
  const { user, error } = await requireAppointmentStaff();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof b.endpoint !== "string" || !b.endpoint.startsWith("https://") || typeof b.keys?.p256dh !== "string" || typeof b.keys?.auth !== "string") {
    return NextResponse.json({ error: "ข้อมูลการสมัครไม่ถูกต้อง" }, { status: 400 });
  }
  const row = { endpoint: b.endpoint, staff_id: user.id, p256dh: b.keys.p256dh, auth: b.keys.auth };
  const db = supabaseAdmin();
  let { error: dbError } = await db.from("push_subscriptions").upsert({
    ...row, user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300), last_seen_at: new Date().toISOString(),
  }, { onConflict: "endpoint" });
  // ยังไม่ได้รัน migration 065 (ไม่มีคอลัมน์ user_agent/last_seen_at): บันทึกแบบเดิม
  if (dbError) ({ error: dbError } = await db.from("push_subscriptions").upsert(row, { onConflict: "endpoint" }));
  if (dbError) return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { user, error } = await requireAppointmentStaff();
  if (error) return error;
  const { endpoint } = (await req.json().catch(() => ({}))) as { endpoint?: string };
  if (endpoint) await supabaseAdmin().from("push_subscriptions").delete().eq("endpoint", endpoint).eq("staff_id", user.id);
  return NextResponse.json({ ok: true });
}
