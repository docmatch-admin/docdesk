import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { CLOSE_PATCH } from "@/lib/case-flow";
import { setConversationTag } from "@/lib/pipeline";
import { awardClosePoints } from "@/lib/score-store";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** กดเสร็จแล้ว: ผ่าน server เพื่อให้คะแนนคนที่ตอบล่าสุดได้ */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const { tag } = (await req.json().catch(() => ({}))) as { tag?: string };
  const db = supabaseAdmin();

  const { data: conv } = await db.from("conversations").select("status, booking_pending").eq("id", id).maybeSingle();
  if (!conv) return NextResponse.json({ error: "ไม่พบแชท" }, { status: 404 });
  if (conv.booking_pending) return NextResponse.json({ error: "ลงนัดก่อน" }, { status: 409 });

  if (tag) {
    const { data: known } = await db.from("tags").select("id").eq("name", tag).maybeSingle();
    if (!known) return NextResponse.json({ error: "ไม่พบแท็กนี้" }, { status: 400 });
    await setConversationTag(id, tag, "add", "staff");
  }
  const { error: updateError } = await db.from("conversations").update(CLOSE_PATCH).eq("id", id);
  if (updateError) {
    console.error(updateError);
    return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  }
  // กดซ้ำในแชทที่เสร็จแล้วไม่ได้คะแนน
  if (conv.status !== "closed") await awardClosePoints(id);
  return NextResponse.json({ ok: true });
}
