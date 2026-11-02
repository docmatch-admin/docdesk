import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { setBatchHidden } from "@/lib/line-import-store";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  const db = supabaseAdmin();
  const [{ data }, { data: logs }] = await Promise.all([
    db.from("import_batches").select("id, filename, rooms, messages_imported, examples_imported, hidden_at, created_at")
      .order("created_at", { ascending: false }).limit(50),
    db.from("archive_merge_log").select("id, action, messages, created_at, staff(display_name), conversations(contacts(display_name))")
      .order("created_at", { ascending: false }).limit(100),
  ]);
  return NextResponse.json({ batches: data ?? [], logs: logs ?? [] });
}

/** เริ่มการนำเข้าหนึ่งชุด */
export async function POST(req: Request) {
  const { user, error } = await requireAdmin();
  if (error) return error;
  const { filename } = (await req.json().catch(() => ({}))) as { filename?: unknown };
  const { data, error: dbError } = await supabaseAdmin().from("import_batches").insert({
    filename: typeof filename === "string" ? filename.slice(0, 200) : null,
    created_by: user.id,
  }).select("id").single();
  if (dbError || !data) return NextResponse.json({ error: "เริ่มนำเข้าไม่สำเร็จ" }, { status: 500 });
  return NextResponse.json({ id: data.id });
}

/** ซ่อนหรือเปิดคำตอบทั้งชุด */
export async function PATCH(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as { id?: unknown; hidden?: unknown };
  if (typeof b.id !== "string" || typeof b.hidden !== "boolean") return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  if (!(await setBatchHidden(b.id, b.hidden))) return NextResponse.json({ error: "ไม่พบชุดนำเข้า" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
