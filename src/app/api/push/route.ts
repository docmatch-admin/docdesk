import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** เครื่องนี้สมัครรับแจ้งเตือน endpoint ต้องเป็น https ของ push service */
export async function POST(req: Request) {
  const { user, error } = await requireStaff();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof b.endpoint !== "string" || !b.endpoint.startsWith("https://") || typeof b.keys?.p256dh !== "string" || typeof b.keys?.auth !== "string") {
    return NextResponse.json({ error: "ข้อมูลการสมัครไม่ถูกต้อง" }, { status: 400 });
  }
  const { error: dbError } = await supabaseAdmin().from("push_subscriptions").upsert({
    endpoint: b.endpoint, staff_id: user.id, p256dh: b.keys.p256dh, auth: b.keys.auth,
  }, { onConflict: "endpoint" });
  if (dbError) return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { user, error } = await requireStaff();
  if (error) return error;
  const { endpoint } = (await req.json().catch(() => ({}))) as { endpoint?: string };
  if (endpoint) await supabaseAdmin().from("push_subscriptions").delete().eq("endpoint", endpoint).eq("staff_id", user.id);
  return NextResponse.json({ ok: true });
}
