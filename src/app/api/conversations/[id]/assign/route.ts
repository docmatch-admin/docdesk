import { NextResponse } from "next/server";
import { assignError } from "@/lib/assignment";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** รับเคส ส่งต่อ หรือเปลี่ยนผู้ดูแล (to = null คือไม่มีผู้ดูแล เฉพาะ admin) */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, role, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const { to } = (await req.json().catch(() => ({}))) as { to?: string | null };
  if (to === undefined) return NextResponse.json({ error: "ไม่มีผู้รับ" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("assigned_to, sensitive").eq("id", id).maybeSingle();
  if (!conv) return NextResponse.json({ error: "ไม่พบแชท" }, { status: 404 });

  const problem = assignError({ id: user.id, role }, (conv.assigned_to as string | null) ?? null, to);
  if (problem) return NextResponse.json({ error: problem }, { status: 403 });

  if (to) {
    const { data: target } = await db.from("staff").select("active, role, can_view_sensitive").eq("id", to).maybeSingle();
    if (!target?.active) return NextResponse.json({ error: "ไม่พบเจ้าหน้าที่คนนี้" }, { status: 400 });
    if (conv.sensitive && target.role !== "admin" && !target.can_view_sensitive) {
      return NextResponse.json({ error: "คนนี้ไม่มีสิทธิ์ดูแชทลับ" }, { status: 400 });
    }
  }
  const { error: rpcError } = await db.rpc("set_assignee", { p_conversation: id, p_to: to, p_by: user.id });
  if (rpcError) {
    console.error(rpcError);
    return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  }
  return NextResponse.json({ assigned_to: to });
}
