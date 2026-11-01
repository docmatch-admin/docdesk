import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { staffChangeError, type StaffPatch, type StaffRow } from "@/lib/staff-rules";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const BAN_FOREVER = "876000h";
const tempPassword = () => crypto.randomBytes(12).toString("base64url");

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  const db = supabaseAdmin();
  const [{ data: rows }, { data: auth }] = await Promise.all([
    db.from("staff").select("id, display_name, role, active, created_at").order("created_at"),
    db.auth.admin.listUsers({ perPage: 500 }),
  ]);
  const emails = new Map((auth?.users ?? []).map((u) => [u.id, u.email]));
  return NextResponse.json({ staff: (rows ?? []).map((s) => ({ ...s, email: emails.get(s.id as string) ?? null })) });
}

/** เพิ่มบัญชี: คืนรหัสผ่านชั่วคราวครั้งเดียว ไม่ใช้อีเมลเชิญเพราะยังไม่ได้ตั้งบริการอีเมล */
export async function POST(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as { email?: string; display_name?: string; role?: string };
  const email = b.email?.trim().toLowerCase();
  const display_name = b.display_name?.trim();
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || !display_name) {
    return NextResponse.json({ error: "กรอกอีเมลและชื่อให้ถูกต้อง" }, { status: 400 });
  }
  const role = b.role === "admin" ? "admin" : "agent";
  const db = supabaseAdmin();
  const password = tempPassword();
  const { data, error: createError } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (createError || !data.user) {
    console.error(createError);
    return NextResponse.json({ error: "สร้างบัญชีไม่สำเร็จ อีเมลนี้อาจมีอยู่แล้ว" }, { status: 400 });
  }
  const { error: insertError } = await db.from("staff").insert({ id: data.user.id, display_name, role });
  if (insertError) {
    await db.auth.admin.deleteUser(data.user.id);
    console.error(insertError);
    return NextResponse.json({ error: "สร้างบัญชีไม่สำเร็จ" }, { status: 500 });
  }
  return NextResponse.json({ id: data.user.id, password });
}

/** เปลี่ยน role, ปิด/เปิดบัญชี, ชื่อ หรือออกรหัสผ่านใหม่ */
export async function PATCH(req: Request) {
  const { user, error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as StaffPatch & { id?: string; reset_password?: boolean };
  if (!b.id) return NextResponse.json({ error: "ไม่มี id" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: all } = await db.from("staff").select("id, role, active");
  const staff = (all ?? []) as StaffRow[];
  const target = staff.find((s) => s.id === b.id);
  if (!target) return NextResponse.json({ error: "ไม่พบบัญชี" }, { status: 404 });

  const patch: StaffPatch = {};
  if (b.role !== undefined) patch.role = b.role;
  if (b.active !== undefined) patch.active = b.active;
  if (b.display_name !== undefined) patch.display_name = b.display_name.trim();
  const problem = staffChangeError(user.id, target, patch, staff);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  if (Object.keys(patch).length) {
    const { error: updateError } = await db.from("staff").update(patch).eq("id", b.id);
    if (updateError) return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  }
  // ปิดบัญชีแล้วต้องล็อกอินใหม่ไม่ได้ด้วย ส่วน session เดิมถูก is_staff() กันไว้แล้ว
  if (patch.active !== undefined) {
    await db.auth.admin.updateUserById(b.id, { ban_duration: patch.active ? "none" : BAN_FOREVER });
  }
  if (b.reset_password) {
    const password = tempPassword();
    const { error: resetError } = await db.auth.admin.updateUserById(b.id, { password });
    if (resetError) return NextResponse.json({ error: "ออกรหัสผ่านไม่สำเร็จ" }, { status: 500 });
    return NextResponse.json({ ok: true, password });
  }
  return NextResponse.json({ ok: true });
}
