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
  // ยังไม่ได้รัน migration 062 = ไม่มีคอลัมน์ ข้ามไป
  await supabaseAdmin().from("conversations").update({ ai_review_at: null }).eq("id", id).not("ai_review_at", "is", null);
  return NextResponse.json({ result: await markConversationRead(id) });
}
