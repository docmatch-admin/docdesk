import { NextResponse } from "next/server";
import { supabaseServer } from "./supabase/server";

export type StaffRole = "admin" | "agent";
export interface StaffContext { id: string; email: string | null; role: StaffRole; displayName: string }

/** เจ้าหน้าที่ที่ล็อกอินอยู่ คืน null ถ้าไม่ได้ล็อกอิน ไม่มีแถวใน staff หรือถูกปิดบัญชี */
export async function getStaffContext(): Promise<StaffContext | null> {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data: staff } = await sb.from("staff").select("id, role, display_name, active").eq("id", user.id).maybeSingle();
  if (!staff?.active) return null;
  return { id: user.id, email: user.email ?? null, role: staff.role as StaffRole, displayName: staff.display_name as string };
}

/** ใช้ใน API route: คืน user ถ้าเป็นเจ้าหน้าที่ ไม่งั้นคืน 401 (ไม่ได้ล็อกอิน) หรือ 403 (ไม่มีแถวใน staff หรือถูกปิดบัญชี) */
export async function requireStaff() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return { user: null, role: null, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } as const;
  }
  const { data: staff } = await sb.from("staff").select("id, role, active").eq("id", user.id).maybeSingle();
  if (!staff?.active) {
    return { user: null, role: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as const;
  }
  return { user, role: staff.role as StaffRole, error: null } as const;
}

/** เหมือน requireStaff แต่ต้องเป็น admin */
export async function requireAdmin() {
  const result = await requireStaff();
  if (result.error) return result;
  if (result.role !== "admin") {
    return { user: null, role: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as const;
  }
  return result;
}
