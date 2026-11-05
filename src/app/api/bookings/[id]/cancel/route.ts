import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * ยกเลิกนัดใน DocDesk เท่านั้น ไม่ส่งข้อความถึงลูกค้า
 * ถ้าต้องแจ้งลูกค้าใช้ปุ่มร่างข้อความเลื่อน/ยกเลิก ยกเลิกนัดที่รอลงนัดแล้วปลดให้กดเสร็จแล้วได้ (trigger ใน migration 023)
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const db = supabaseAdmin();
  const { data: owner } = await db.from("bookings").select("conversation_id").eq("id", id).maybeSingle();
  if (!owner) return NextResponse.json({ error: "ไม่พบนัด" }, { status: 404 });
  const denied = await denySensitiveChat(owner.conversation_id as string, canViewSensitive);
  if (denied) return denied;
  const { data, error: dbError } = await db.from("bookings")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id).neq("status", "cancelled").select("id");
  if (dbError) return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  if (!data?.length) return NextResponse.json({ error: "นัดนี้ถูกยกเลิกไปแล้ว" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
