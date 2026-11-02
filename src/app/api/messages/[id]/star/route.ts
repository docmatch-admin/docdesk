import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { starMessage } from "@/lib/pipeline";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const { data: m } = await supabaseAdmin().from("messages").select("conversation_id").eq("id", id).maybeSingle();
  if (m) {
    const denied = await denySensitiveChat(m.conversation_id as string, canViewSensitive);
    if (denied) return denied;
  }
  try {
    await starMessage(id, user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "ไม่สำเร็จ" }, { status: 400 });
  }
}
