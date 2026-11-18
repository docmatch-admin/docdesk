import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { markConversationRead } from "@/lib/pipeline";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** เจ้าหน้าที่เปิดอ่านแชท: แจ้งแพลตฟอร์มให้ลูกค้าเห็นว่าอ่านแล้ว + เคลียร์ "AI ตอบแล้ว รอตรวจ" (ช่วงงานค้าง) */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  // ล้างตัวเลขยังไม่อ่าน + "AI ตอบแล้ว รอตรวจ" ในครั้งเดียว (เดิมหน้าเว็บยิงแยกอีก 1 request)
  // อัปเดตเฉพาะเมื่อมีอะไรเปลี่ยน ไม่อย่างนั้น realtime ยิงไปทุกเครื่องโดยไม่จำเป็น
  const db = supabaseAdmin();
  const { error: e1 } = await db.from("conversations").update({ unread_count: 0, ai_review_at: null }).eq("id", id).or("unread_count.gt.0,ai_review_at.not.is.null");
  // ยังไม่ได้รัน migration 062 = ไม่มีคอลัมน์ ai_review_at
  if (e1) await db.from("conversations").update({ unread_count: 0 }).eq("id", id).gt("unread_count", 0);
  return NextResponse.json({ result: await markConversationRead(id) });
}
