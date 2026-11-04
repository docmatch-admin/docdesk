import { NextResponse } from "next/server";
import { denyArchivedChat, denySensitiveChat, requireStaff } from "@/lib/auth";
import { MediaError } from "@/lib/media";
import { sendMediaReply } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

const STAFF_UPLOAD_RE = /^uploads\/staff-[0-9a-f-]{36}$/i;
const MEDIA_ERROR_TEXT: Record<MediaError["code"], string> = {
  unsupported: "รองรับรูป JPEG, PNG, WebP, HEIC และไฟล์ PDF",
  too_large: "รูปต้องไม่เกิน 10MB และ PDF ต้องไม่เกิน 25MB",
  corrupt: "ไฟล์เสียหาย เปิดไม่ได้",
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const archived = await denyArchivedChat(id);
  if (archived) return archived;
  const body = (await req.json().catch(() => ({}))) as {
    uploadPath?: string; quickMediaId?: string; caption?: string; skipTranslate?: boolean; fileName?: string;
  };
  if (body.uploadPath && !STAFF_UPLOAD_RE.test(body.uploadPath)) {
    return NextResponse.json({ error: "ไฟล์ไม่ถูกต้อง" }, { status: 400 });
  }
  if (!body.uploadPath && !body.quickMediaId) {
    return NextResponse.json({ error: "ไม่มีรูปที่จะส่ง" }, { status: 400 });
  }

  try {
    return NextResponse.json(await sendMediaReply({
      conversationId: id,
      uploadPath: body.uploadPath,
      fileName: typeof body.fileName === "string" ? body.fileName : undefined,
      quickMediaId: body.quickMediaId,
      captionTh: body.caption,
      senderId: user.id,
      skipTranslate: !!body.skipTranslate,
      origin: new URL(req.url).origin,
    }));
  } catch (e) {
    if (e instanceof MediaError) {
      return NextResponse.json({ error: MEDIA_ERROR_TEXT[e.code] }, { status: 400 });
    }
    console.error(e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "ส่งไม่สำเร็จ" }, { status: 500 });
  }
}
