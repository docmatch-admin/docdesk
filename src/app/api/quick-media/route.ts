import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { MediaError } from "@/lib/media";
import { consumeUpload, QUICK_BUCKET, removeFiles } from "@/lib/media-store";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

const STAFF_UPLOAD_RE = /^uploads\/staff-[0-9a-f-]{36}$/i;

/** เพิ่มรูปที่ใช้บ่อย */
export async function POST(req: Request) {
  const { user, error } = await requireStaff();
  if (error) return error;
  const { uploadPath, title } = (await req.json().catch(() => ({}))) as { uploadPath?: string; title?: string };
  if (!uploadPath || !STAFF_UPLOAD_RE.test(uploadPath) || !title?.trim()) {
    return NextResponse.json({ error: "ต้องมีรูปและชื่อรูป" }, { status: 400 });
  }
  try {
    const media = await consumeUpload(uploadPath, QUICK_BUCKET);
    const { data, error: dbError } = await supabaseAdmin().from("quick_media").insert({
      title: title.trim().slice(0, 100), path: media.path, preview_path: media.previewPath, created_by: user.id,
    }).select("id").single();
    if (dbError) throw dbError;
    return NextResponse.json(data);
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: "ไฟล์นี้ใช้ไม่ได้ รองรับ JPEG, PNG, WebP, HEIC ไม่เกิน 10MB" }, { status: 400 });
    console.error(e);
    return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const { error } = await requireStaff();
  if (error) return error;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "ไม่มี id" }, { status: 400 });
  const db = supabaseAdmin();
  const { data: row } = await db.from("quick_media").select("path, preview_path").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "ไม่พบรูป" }, { status: 404 });
  await db.from("quick_media").delete().eq("id", id);
  await removeFiles(QUICK_BUCKET, [row.path as string, row.preview_path as string]);
  return NextResponse.json({ ok: true });
}
