import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { logSensitiveAccess, markConversationSensitive, unmarkConversationSensitive } from "@/lib/sensitive-store";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * sensitive true = เจ้าหน้าที่ตั้งเป็นแชทลับ
 * sensitive false = เอาออก ทำได้เฉพาะ admin และบันทึก log
 * reveal true = กดแสดงข้อความ บันทึก log
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, role, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as { sensitive?: unknown; reveal?: unknown };

  const { data: conv } = await supabaseAdmin().from("conversations").select("sensitive").eq("id", id).maybeSingle();
  if (!conv) return NextResponse.json({ error: "ไม่พบแชท" }, { status: 404 });

  if (b.reveal === true) {
    if (conv.sensitive) await logSensitiveAccess(user.id, id, "reveal");
    return NextResponse.json({ ok: true });
  }
  if (b.sensitive === true) {
    await markConversationSensitive(id, "เจ้าหน้าที่");
    return NextResponse.json({ ok: true });
  }
  if (b.sensitive === false) {
    if (role !== "admin") return NextResponse.json({ error: "เอาออกได้เฉพาะ admin" }, { status: 403 });
    if (conv.sensitive) await unmarkConversationSensitive(id, user.id);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
}
