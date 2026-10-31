import { NextResponse } from "next/server";
import { supabaseServer } from "./supabase/server";

/** ใช้ใน API route: คืน user ถ้าเป็นเจ้าหน้าที่ ไม่งั้นคืน 401 (ไม่ได้ล็อกอิน) หรือ 403 (ไม่มีแถวใน staff) */
export async function requireStaff() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return { user: null, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } as const;
  }
  const { data: staff } = await sb.from("staff").select("id").eq("id", user.id).maybeSingle();
  if (!staff) {
    return { user: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as const;
  }
  return { user, error: null } as const;
}
