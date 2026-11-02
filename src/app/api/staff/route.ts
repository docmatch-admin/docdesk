import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { hrSyncEnabled } from "@/lib/hr-sync";
import { generateTempPassword, resetStaffPassword, setStaffActive } from "@/lib/staff-admin";
import { isValidUsername, STAFF_EMAIL_DOMAIN } from "@/lib/staff-login";
import { staffChangeError, type StaffPatch, type StaffRow } from "@/lib/staff-rules";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  const db = supabaseAdmin();
  const [{ data: rows }, { data: auth }] = await Promise.all([
    db.from("staff")
      .select("id, display_name, role, active, created_at, username, must_change_password, hr_employee_id, full_name, position, can_view_sensitive")
      .order("created_at"),
    db.auth.admin.listUsers({ perPage: 500 }),
  ]);
  const emails = new Map((auth?.users ?? []).map((u) => [u.id, u.email]));
  return NextResponse.json({
    staff: (rows ?? []).map((s) => ({ ...s, email: emails.get(s.id as string) ?? null })),
    hrEnabled: hrSyncEnabled(),
  });
}

/** เพิ่มพนักงาน: คืนรหัสชั่วคราวครั้งเดียว ไม่เก็บรหัสในฐานข้อมูลหรือ log */
export async function POST(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as { username?: string; display_name?: string; role?: string };
  const username = b.username?.trim().toLowerCase() ?? "";
  const display_name = b.display_name?.trim();
  if (!display_name) return NextResponse.json({ error: "กรอกชื่อที่แสดง" }, { status: 400 });
  if (!isValidUsername(username)) {
    return NextResponse.json({ error: "ชื่อผู้ใช้ต้องเป็น a-z 0-9 . _ ยาว 3–20 ตัว และห้ามมีจุดต้นท้ายหรือจุดติดกัน" }, { status: 400 });
  }
  const role = b.role === "admin" ? "admin" : "agent";
  const db = supabaseAdmin();
  const password = generateTempPassword();
  const { data, error: createError } = await db.auth.admin.createUser({
    email: `${username}@${STAFF_EMAIL_DOMAIN}`, password, email_confirm: true,
  });
  if (createError || !data.user) {
    console.error("สร้างบัญชีไม่สำเร็จ", createError?.code);
    return NextResponse.json({ error: "สร้างบัญชีไม่สำเร็จ ชื่อผู้ใช้นี้อาจมีอยู่แล้ว" }, { status: 400 });
  }
  const { error: insertError } = await db.from("staff").insert({
    id: data.user.id, display_name, role, username, must_change_password: true,
  });
  if (insertError) {
    await db.auth.admin.deleteUser(data.user.id);
    console.error("เพิ่มเจ้าหน้าที่ไม่สำเร็จ", insertError.code);
    return NextResponse.json({ error: "สร้างบัญชีไม่สำเร็จ" }, { status: 500 });
  }
  return NextResponse.json({ id: data.user.id, username, display_name, password }, { headers: NO_STORE });
}

/** เปลี่ยน role, ปิด/เปิดบัญชี, ชื่อ, จับคู่ HR หรือรีเซ็ตรหัส */
export async function PATCH(req: Request) {
  const { user, error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as StaffPatch & {
    id?: string; reset_password?: boolean; hr_employee_id?: string | null; can_view_sensitive?: boolean;
  };
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
  if (b.reset_password) patch.reset_password = true;
  const problem = staffChangeError(user.id, target, patch, staff);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  if (b.hr_employee_id && !UUID.test(b.hr_employee_id)) return NextResponse.json({ error: "รหัสพนักงาน HR ไม่ถูกต้อง" }, { status: 400 });

  const fields: Record<string, unknown> = {};
  if (patch.role !== undefined) fields.role = patch.role;
  if (patch.display_name !== undefined) fields.display_name = patch.display_name;
  if (b.hr_employee_id !== undefined) fields.hr_employee_id = b.hr_employee_id || null;
  if (typeof b.can_view_sensitive === "boolean") fields.can_view_sensitive = b.can_view_sensitive;
  // ลดจาก admin ต้องไม่เหลือสิทธิ์แชทลับติดมา
  if (patch.role === "agent" && target.role === "admin" && b.can_view_sensitive === undefined) fields.can_view_sensitive = false;
  if (Object.keys(fields).length) {
    const { error: updateError } = await db.from("staff").update(fields).eq("id", b.id);
    if (updateError) {
      const message = updateError.code === "23505" ? "พนักงาน HR คนนี้จับคู่กับบัญชีอื่นแล้ว" : "บันทึกไม่สำเร็จ";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }
  // ไม่มีสิทธิ์แล้วต้องไม่เป็นผู้ดูแลแชทลับ
  if (fields.can_view_sensitive === false) {
    const { data: chats } = await db.from("conversations").select("id").eq("assigned_to", b.id).eq("sensitive", true);
    for (const chat of (chats ?? []) as { id: string }[]) {
      await db.rpc("set_assignee", { p_conversation: chat.id, p_to: null, p_by: user.id });
    }
  }
  if (patch.active !== undefined) {
    const failure = await setStaffActive(b.id, !!patch.active, user.id);
    if (failure) return NextResponse.json({ error: failure }, { status: 500 });
  }
  if (b.reset_password) {
    const password = await resetStaffPassword(b.id);
    if (!password) return NextResponse.json({ error: "รีเซ็ตรหัสไม่สำเร็จ" }, { status: 500 });
    return NextResponse.json({ ok: true, password }, { headers: NO_STORE });
  }
  return NextResponse.json({ ok: true });
}
