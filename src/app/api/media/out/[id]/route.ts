import { NextResponse } from "next/server";
import { CHAT_BUCKET, downloadFile } from "@/lib/media-store";
import { verifyOutMediaSignature } from "@/lib/media-url";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** รูปขาออกให้ LINE/Meta ดึง: ไม่ต้องล็อกอินเพราะแพลตฟอร์มต้องดึงได้ ป้องกันด้วยลายเซ็นที่หมดอายุ */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  const v = q.get("v");
  if (!verifyOutMediaSignature(id, { v, exp: q.get("exp"), sig: q.get("sig") })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { data: m } = await supabaseAdmin().from("messages")
    .select("direction, media_path, media_preview_path").eq("id", id).maybeSingle();
  const path = v === "preview" ? m?.media_preview_path : m?.media_path;
  if (!m || m.direction !== "out" || !path) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    const bytes = await downloadFile(CHAT_BUCKET, path as string);
    return new NextResponse(new Uint8Array(bytes), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" },
    });
  } catch (e) {
    console.error("serve media failed", e);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
