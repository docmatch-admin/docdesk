import { NextResponse } from "next/server";
import { embed } from "@/lib/ai";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { SYMPTOM_GUIDE_CATEGORY } from "@/lib/symptom-rules";

export const runtime = "nodejs";

/** เพิ่ม/แก้ข้อมูลคลินิก (สร้าง embedding ใหม่ทุกครั้ง) */
export async function POST(req: Request) {
  const { user, error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as {
    id?: string; category?: string; title?: string; content?: string; active?: boolean;
  };
  const guide = b.category?.trim() === SYMPTOM_GUIDE_CATEGORY;
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
    // แก้แนวทางซักอาการแล้วต้องให้แพทย์อนุมัติใหม่
    ...(guide ? { review_status: "draft", reviewed_by: null, reviewed_at: null } : {}),
    updated_at: new Date().toISOString(),
    embedding: JSON.stringify(await embed(`${category} | ${b.title}\n${b.content}`)),
  };
  const db = supabaseAdmin();
  // service role ข้าม trigger ในฐานข้อมูล จึงต้องตรวจที่นี่ด้วย
  if (b.id) {
    const { data: current } = await db.from("knowledge_items").select("source").eq("id", b.id).maybeSingle();
    if (current?.source === "website") return NextResponse.json({ error: "ข้อมูลจากเว็บ ต้องแก้ที่หลังบ้านเว็บ" }, { status: 409 });
  }
  const q = b.id
    ? db.from("knowledge_items").update(row).eq("id", b.id)
    : db.from("knowledge_items").insert(row);
  const { data, error: e } = await q.select("id, category, title, content, active, updated_at, review_status").single();
  if (e) return NextResponse.json({ error: e.message }, { status: 500 });
  return NextResponse.json(data);
}
