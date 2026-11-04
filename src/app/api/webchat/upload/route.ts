import { NextResponse } from "next/server";
import { MAX_WEB_IMAGE_BYTES, MediaError } from "@/lib/media";
import { MAX_WEB_FILE_BYTES } from "@/lib/files";
import { CHAT_BUCKET, consumeUploadAny, createUploadSlot } from "@/lib/media-store";
import { storeIncoming } from "@/lib/pipeline";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { admitWebchatImage, clientIp, corsHeaders, hashIp, isAllowedOrigin } from "@/lib/webchat-guard";

export const runtime = "nodejs";
export const maxDuration = 60;

const SESSION_RE = /^[0-9a-f-]{36}$/i;
const UUID = "[0-9a-f-]{36}";

export function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new NextResponse(null, { status: isAllowedOrigin(origin) ? 204 : 403, headers: corsHeaders(origin) });
}

/**
 * ไม่มี path = ขอช่องอัปโหลด (นับรูปละ 1 ข้อความตาม rate limit เดียวกับข้อความ และนับเพดานรูปรายวัน ไม่นับเพดาน AI)
 * มี path = อัปโหลดเสร็จแล้ว ให้ตรวจและเก็บ
 * widget อัปโหลดตรงเข้า Storage เพราะ Vercel รับ request ได้ไม่เกิน 4.5MB
 */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (!isAllowedOrigin(origin)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: cors });

  const { session, path, name } = (await req.json().catch(() => ({}))) as { session?: string; path?: string; name?: string };
  if (!session || !SESSION_RE.test(session)) {
    return NextResponse.json({ error: "invalid" }, { status: 400, headers: cors });
  }

  if (!path) {
    let slot;
    try {
      const admission = await admitWebchatImage(supabaseAdmin(), session, hashIp(clientIp(req.headers)));
      if (!admission.allowed) {
        const error = admission.reason === "images_day" ? "image_cap" : "rate_limited";
        return NextResponse.json({ error }, { status: 429, headers: cors });
      }
      slot = await createUploadSlot(`web-${session}`);
    } catch (e) {
      console.error("webchat upload slot failed", e);
      return NextResponse.json({ error: "unavailable" }, { status: 503, headers: cors });
    }
    return NextResponse.json(slot, { headers: cors });
  }

  // รับเฉพาะไฟล์พักของ session นี้
  if (!new RegExp(`^uploads/web-${session}-${UUID}$`, "i").test(path)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: cors });
  }
  try {
    // รูปหรือ PDF ตัดสินจากเนื้อไฟล์
    const up = await consumeUploadAny(path, CHAT_BUCKET, { maxImage: MAX_WEB_IMAGE_BYTES, maxFile: MAX_WEB_FILE_BYTES, fileName: typeof name === "string" ? name : null });
    const stored = up.kind === "image"
      ? await storeIncoming({ channelType: "web", externalId: session, text: "", isImage: true, media: up.media })
      : await storeIncoming({ channelType: "web", externalId: session, text: "", file: { name: up.file.name, size: up.file.size, stored: up.file } });
    return NextResponse.json({ ok: true, id: stored.messageId }, { headers: cors });
  } catch (e) {
    if (e instanceof MediaError) {
      return NextResponse.json({ error: e.code }, { status: e.code === "too_large" ? 413 : 400, headers: cors });
    }
    console.error("webchat upload failed", e);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: cors });
  }
}
