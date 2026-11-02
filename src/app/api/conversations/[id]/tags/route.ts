import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { setConversationTag } from "@/lib/pipeline";
import { SENSITIVE_TAG } from "@/lib/sensitive-rules";
import { markConversationSensitive } from "@/lib/sensitive-store";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** เจ้าหน้าที่ติดหรือเอาแท็กออก ผ่าน server เพื่อให้มี tag_events สำหรับรายงานเสมอ */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const { tag, action } = (await req.json().catch(() => ({}))) as { tag?: string; action?: string };
  if (!tag?.trim() || (action !== "add" && action !== "remove")) {
    return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  }
  // แท็กนี้คู่กับสถานะแชทลับ เอาออกต้องผ่าน admin และบันทึก log
  if (tag === SENSITIVE_TAG) {
    if (action === "remove") return NextResponse.json({ error: "เอาออกได้เฉพาะ admin ที่ปุ่มในห้องแชท" }, { status: 403 });
    await markConversationSensitive(id, "เจ้าหน้าที่");
    return NextResponse.json({ ok: true });
  }
  if (action === "add") {
    const { data: known } = await supabaseAdmin().from("tags").select("id").eq("name", tag).maybeSingle();
    if (!known) return NextResponse.json({ error: "ไม่พบแท็กนี้" }, { status: 400 });
  }
  try {
    return NextResponse.json({ tags: await setConversationTag(id, tag, action, "staff") });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "บันทึกแท็กไม่สำเร็จ" }, { status: 500 });
  }
}
