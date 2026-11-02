import { NextResponse } from "next/server";
import { MIN_PASSWORD_LENGTH } from "@/lib/staff-login";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** เปลี่ยนรหัสของตัวเอง ไม่ใช้ requireStaff เพราะบัญชีที่ต้องเปลี่ยนรหัสถูกกันจาก API อื่นทั้งหมด */
export async function POST(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: staff } = await sb.from("staff").select("active").eq("id", user.id).maybeSingle();
  if (!staff?.active) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { password } = (await req.json().catch(() => ({}))) as { password?: unknown };
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > 72) {
    return NextResponse.json({ error: `รหัสผ่านต้องยาว ${MIN_PASSWORD_LENGTH}–72 ตัว` }, { status: 400 });
  }
  const { error } = await sb.auth.updateUser({ password });
  if (error) {
    if (error.code === "same_password") return NextResponse.json({ error: "ต้องตั้งรหัสใหม่ที่ไม่ซ้ำกับรหัสชั่วคราว" }, { status: 400 });
    if (error.code === "weak_password") return NextResponse.json({ error: "รหัสผ่านนี้คาดเดาง่ายเกินไป" }, { status: 400 });
    console.error("เปลี่ยนรหัสไม่สำเร็จ", error.code);
    return NextResponse.json({ error: "เปลี่ยนรหัสไม่สำเร็จ" }, { status: 500 });
  }
  const { error: flagError } = await supabaseAdmin().from("staff").update({ must_change_password: false }).eq("id", user.id);
  if (flagError) return NextResponse.json({ error: "เปลี่ยนรหัสไม่สำเร็จ" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
