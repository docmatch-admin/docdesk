import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** รับทราบข้อกำหนดแชทลับ ครั้งแรกที่เปิด */
export async function POST() {
  const { user, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  if (!canViewSensitive) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { error: dbError } = await supabaseAdmin().from("staff").update({ sensitive_ack_at: new Date().toISOString() }).eq("id", user.id);
  if (dbError) return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
