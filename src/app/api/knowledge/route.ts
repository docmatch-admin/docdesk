import { NextResponse } from "next/server";
import { embed } from "@/lib/ai";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** เพิ่ม/แก้ข้อมูลคลินิก (สร้าง embedding ใหม่ทุกครั้ง) */
export async function POST(req: Request) {
  const { user, error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as {
    id?: string; category?: string; title?: string; content?: string; active?: boolean;
  };
  if (!b.title?.trim() || !b.content?.trim()) {
    return NextResponse.json({ error: "กรอกหัวข้อและรายละเอียด" }, { status: 400 });
  }
  const category = b.category?.trim() || "ทั่วไป";
  const row = {
    category,
    title: b.title.trim(),
    content: b.content.trim(),
    active: b.active ?? true,
    updated_by: user.id,
    updated_at: new Date().toISOString(),
    embedding: JSON.stringify(await embed(`${category} | ${b.title}\n${b.content}`)),
  };
  const db = supabaseAdmin();
  const q = b.id
    ? db.from("knowledge_items").update(row).eq("id", b.id)
    : db.from("knowledge_items").insert(row);
  const { data, error: e } = await q.select("id, category, title, content, active, updated_at").single();
  if (e) return NextResponse.json({ error: e.message }, { status: 500 });
  return NextResponse.json(data);
}
