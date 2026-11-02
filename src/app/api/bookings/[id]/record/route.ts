import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { setConversationTag } from "@/lib/pipeline";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** กด "ลงนัดแล้ว": หยุดเตือน และปลดให้กดเสร็จแล้วได้ */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const { data: owner } = await supabaseAdmin().from("bookings").select("conversation_id").eq("id", id).maybeSingle();
  if (owner) {
    const denied = await denySensitiveChat(owner.conversation_id as string, canViewSensitive);
    if (denied) return denied;
  }
  const now = new Date().toISOString();
  const { data, error: dbError } = await supabaseAdmin().from("bookings")
    .update({ status: "recorded", recorded_at: now, recorded_by: user.id, updated_at: now })
    .eq("id", id).eq("status", "ai_confirmed").select("conversation_id");
  if (dbError) return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  if (!data?.length) return NextResponse.json({ error: "นัดนี้ลงไปแล้วหรือถูกยกเลิก" }, { status: 409 });
  await setConversationTag(data[0].conversation_id as string, "นัดแล้ว", "add", "staff")
    .catch((e) => console.error("booking tag failed", e));
  return NextResponse.json({ ok: true });
}
