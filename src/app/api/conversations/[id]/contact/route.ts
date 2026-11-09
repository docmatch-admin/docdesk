import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** เจ้าหน้าที่ตั้งชื่อลูกค้าเอง แล้วล็อกไว้ไม่ให้ชื่อจาก LINE/Facebook เขียนทับ */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;

  const b = (await req.json().catch(() => ({}))) as { displayName?: unknown };
  const name = typeof b.displayName === "string" ? b.displayName.replace(/\s+/g, " ").trim() : "";
  if (!name || [...name].length > 80) return NextResponse.json({ error: "ชื่อต้องยาว 1–80 ตัวอักษร" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("contact_id").eq("id", id).maybeSingle();
  if (!conv) return NextResponse.json({ error: "ไม่พบแชทนี้" }, { status: 404 });
  const { data: current } = await db.from("contacts").select("name_source").eq("id", conv.contact_id as string).maybeSingle();
  // ผูก HN แล้วชื่อที่แสดงยังเป็นชื่อจาก HIS (his > staff) ชื่อนี้ใช้เมื่อยกเลิกการผูก
  const { error: upErr } = await db.from("contacts").update({
    display_name: name, name_locked: true, ...(current?.name_source === "his" ? {} : { name_source: "staff" }),
  }).eq("id", conv.contact_id as string);
  if (upErr) {
    console.error("rename contact failed", upErr.code);
    return NextResponse.json({ error: "แก้ชื่อไม่สำเร็จ" }, { status: 500 });
  }
  return NextResponse.json({ displayName: name });
}
