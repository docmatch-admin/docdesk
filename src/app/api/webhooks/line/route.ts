import { after, NextResponse } from "next/server";
import { getLineProfile, lineContentRequest, verifyLineSignature } from "@/lib/channels/line";
import { logSystemError } from "@/lib/health";
import { downloadLimited } from "@/lib/media";
import { ingestInboundImage } from "@/lib/media-store";
import { processIncoming, storeIncoming } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { type: string; userId?: string };
  message?: { id: string; type: string; text?: string; markAsReadToken?: string };
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyLineSignature(raw, req.headers.get("x-line-signature"))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const { events = [] } = JSON.parse(raw) as { events: LineEvent[] };

  try {
  for (const ev of events) {
    const userId = ev.source?.userId;
    if (ev.type !== "message" || !userId || ev.source?.type !== "user" || !ev.message) continue;

    const isImage = ev.message.type === "image";
    // รองรับข้อความและรูป ประเภทอื่นบันทึกเป็นข้อความแจ้งเตือน
    const text = ev.message.type === "text"
      ? ev.message.text ?? ""
      : isImage ? "" : `[ลูกค้าส่ง ${ev.message.type} — เปิดดูใน LINE OA]`;

    const profile = await getLineProfile(userId);
    const stored = await storeIncoming({
      channelType: "line",
      externalId: userId,
      text,
      displayName: profile.displayName,
      avatarUrl: profile.pictureUrl,
      externalMessageId: ev.message.id,
      replyToken: ev.replyToken,
      markAsReadToken: ev.message.markAsReadToken,
      isImage,
    });

    if (stored.duplicate) continue;
    if (isImage) {
      const content = lineContentRequest(ev.message.id);
      after(() => ingestInboundImage(stored.messageId, () => downloadLimited(content.url, content.headers)));
    } else if (ev.message.type === "text") {
      after(() => processIncoming(stored.conversationId, stored.messageId, ev.replyToken).catch((e) => {
        console.error("processIncoming", e);
        return logSystemError("webhook:line", e);
      }));
    }
  }
  } catch (e) {
    // ตอบ error เหมือนเดิมเพื่อให้ LINE ส่งซ้ำ แต่เก็บไว้ให้ตัวตรวจสุขภาพเห็น
    await logSystemError("webhook:line", e);
    throw e;
  }

  return NextResponse.json({ ok: true });
}
