import { NextResponse } from "next/server";
import { CHAT_BUCKET, downloadFile } from "./media-store";
import { verifyOutMediaSignature } from "./media-url";
import { supabaseAdmin } from "./supabase/admin";

/**
 * รูปและไฟล์ขาออกให้ LINE/Meta/ลูกค้าดึง: ไม่ต้องล็อกอินเพราะแพลตฟอร์มต้องดึงได้ ป้องกันด้วยลายเซ็นที่หมดอายุ
 * ไฟล์มีชื่อไฟล์ต่อท้าย URL ได้ (/api/media/out/{id}/{ชื่อไฟล์}) ให้ Messenger แสดงชื่อ
 */
export async function serveOutMedia(req: Request, id: string) {
  const q = new URL(req.url).searchParams;
  const v = q.get("v");
  if (!verifyOutMediaSignature(id, { v, exp: q.get("exp"), sig: q.get("sig") })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { data: m } = await supabaseAdmin().from("messages")
    .select("direction, media_type, media_path, media_preview_path, file_name").eq("id", id).maybeSingle();
  const isFile = m?.media_type === "file";
  // ลายเซ็นของรูปใช้เปิดไฟล์ไม่ได้ และกลับกัน
  if (!m || m.direction !== "out" || isFile !== (v === "file")) return NextResponse.json({ error: "not found" }, { status: 404 });
  const path = v === "preview" ? m.media_preview_path : m.media_path;
  if (!path) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    const bytes = await downloadFile(CHAT_BUCKET, path as string);
    const headers: Record<string, string> = {
      "Content-Type": isFile ? "application/pdf" : "image/jpeg",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    };
    if (isFile) {
      const name = (m.file_name as string | null) || "document.pdf";
      const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
      headers["Content-Disposition"] = `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    }
    return new NextResponse(new Uint8Array(bytes), { headers });
  } catch (e) {
    console.error("serve media failed", e);
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
