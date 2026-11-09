import { NextResponse } from "next/server";
import { supabaseAdmin } from "./supabase/admin";
import { supabaseServer } from "./supabase/server";

/** pharmacy = พยาบาล/ห้องยา เข้าได้เฉพาะหน้านัดหมาย */
export type StaffRole = "admin" | "agent" | "pharmacy";
export interface StaffContext { id: string; email: string | null; role: StaffRole; displayName: string; mustChangePassword: boolean; canViewSensitive: boolean; sensitiveAcked: boolean }

/** เจ้าหน้าที่ที่ล็อกอินอยู่ คืน null ถ้าไม่ได้ล็อกอิน ไม่มีแถวใน staff หรือถูกปิดบัญชี */
export async function getStaffContext(): Promise<StaffContext | null> {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data: staff } = await sb.from("staff").select("id, role, display_name, active, must_change_password, can_view_sensitive, sensitive_ack_at").eq("id", user.id).maybeSingle();
  if (!staff?.active) return null;
  return { id: user.id, email: user.email ?? null, role: staff.role as StaffRole, displayName: staff.display_name as string, mustChangePassword: !!staff.must_change_password, canViewSensitive: staff.role === "admin" || !!staff.can_view_sensitive, sensitiveAcked: !!staff.sensitive_ack_at };
}

/** ใช้ใน API route: คืน user ถ้าเป็นเจ้าหน้าที่ ไม่งั้นคืน 401 (ไม่ได้ล็อกอิน) หรือ 403 (ไม่มีแถวใน staff, ถูกปิดบัญชี หรือยังไม่เปลี่ยนรหัสชั่วคราว)
 * ห้องยา (pharmacy) ไม่ผ่าน เพราะทุก API ที่ใช้ตัวนี้แตะแชท ใช้ requireAppointmentStaff กับ API นัดหมายแทน */
export async function requireStaff() {
  const result = await requireAnyStaff();
  if (!result.error && result.role === "pharmacy") {
    return { user: null, role: null, canViewSensitive: false, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as const;
  }
  return result;
}

/** API นัดหมาย: admin, agent และห้องยา */
export const requireAppointmentStaff = () => requireAnyStaff();

async function requireAnyStaff() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return { user: null, role: null, canViewSensitive: false, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } as const;
  }
  const { data: staff } = await sb.from("staff").select("id, role, active, must_change_password, can_view_sensitive").eq("id", user.id).maybeSingle();
  if (!staff?.active) {
    return { user: null, role: null, canViewSensitive: false, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as const;
  }
  if (staff.must_change_password) {
    return { user: null, role: null, canViewSensitive: false, error: NextResponse.json({ error: "must_change_password" }, { status: 403 }) } as const;
  }
  return { user, role: staff.role as StaffRole, canViewSensitive: staff.role === "admin" || !!staff.can_view_sensitive, error: null } as const;
}

/** เหมือน requireStaff แต่ต้องเป็น admin */
export async function requireAdmin() {
  const result = await requireStaff();
  if (result.error) return result;
  if (result.role !== "admin") {
    return { user: null, role: null, canViewSensitive: false, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as const;
  }
  return result;
}

/** แชทลับกับคนที่ไม่มีสิทธิ์: คืน 403 ใช้ทุก API ที่รับ id ของแชท เพราะฝั่ง server ใช้ service role ซึ่งข้าม RLS */
export async function denySensitiveChat(conversationId: string, canViewSensitive: boolean) {
  if (canViewSensitive) return null;
  const { data } = await supabaseAdmin().from("conversations").select("sensitive").eq("id", conversationId).maybeSingle();
  return data?.sensitive ? NextResponse.json({ error: "sensitive_forbidden" }, { status: 403 }) : null;
}

export const ARCHIVED_CHAT_NOTICE = "แชทนำเข้าจาก LINE OA ส่งข้อความไม่ได้ รอลูกค้าทักมาใหม่";

/** แชทเก่าไม่มี userId จริงของ LINE จึงส่งไม่ได้ */
export async function denyArchivedChat(conversationId: string) {
  const { data } = await supabaseAdmin().from("conversations").select("archived").eq("id", conversationId).maybeSingle();
  return data?.archived ? NextResponse.json({ error: ARCHIVED_CHAT_NOTICE }, { status: 409 }) : null;
}
