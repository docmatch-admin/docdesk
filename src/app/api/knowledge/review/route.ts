import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { SYMPTOM_GUIDE_CATEGORY } from "@/lib/symptom-rules";

export const runtime = "nodejs";

/** admin กด "แพทย์อนุมัติแล้ว" ให้ AI ใช้แนวทางซักอาการนี้ได้ */
export async function POST(req: Request) {
  const { user, error } = await requireAdmin();
  if (error) return error;
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id) return NextResponse.json({ error: "ไม่พบรายการ" }, { status: 400 });
  const db = supabaseAdmin();
  const { data: item } = await db.from("knowledge_items").select("category").eq("id", id).maybeSingle();
  if (item?.category !== SYMPTOM_GUIDE_CATEGORY) return NextResponse.json({ error: "อนุมัติได้เฉพาะแนวทางซักอาการ" }, { status: 400 });
  const { error: e } = await db.from("knowledge_items")
    .update({ review_status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString() }).eq("id", id);
  if (e) return NextResponse.json({ error: e.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
