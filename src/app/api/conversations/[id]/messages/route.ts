import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { logSensitiveAccess } from "@/lib/sensitive-store";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** เปิดห้องแชทลับผ่านเส้นทางนี้ เพื่อบันทึกการเข้าถึงทุกครั้ง */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;

  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("sensitive").eq("id", id).maybeSingle();
  if (!conv) return NextResponse.json({ error: "ไม่พบแชท" }, { status: 404 });
  if (conv.sensitive) {
    const { data: me } = await db.from("staff").select("sensitive_ack_at").eq("id", user.id).maybeSingle();
    if (!me?.sensitive_ack_at) return NextResponse.json({ error: "ack_required" }, { status: 428 });
    await logSensitiveAccess(user.id, id, "open");
  }
  const { data } = await db.from("messages").select("*").eq("conversation_id", id).order("created_at", { ascending: false }).limit(300);
  return NextResponse.json({ messages: (data ?? []).reverse() }, { headers: { "Cache-Control": "no-store" } });
}
