import { after, NextResponse } from "next/server";
import { getLineProfile, lineContentRequest, verifyLineSignature } from "@/lib/channels/line";
import { logSystemError } from "@/lib/health";
import { isPdfName, MAX_FILE_BYTES, sanitizeFileName } from "@/lib/files";
import { downloadLimited } from "@/lib/media";
import { ingestInboundFile, ingestInboundImage } from "@/lib/media-store";
import { processIncoming, storeIncoming } from "@/lib/pipeline";
import { parseAppointmentPostback, parseLinkCode } from "@/lib/appointment-rules";
import { handleAppointmentPostback, handleLinkCode } from "@/lib/appointment-store";

export const runtime = "nodejs";
export const maxDuration = 60;

interface LineEvent {
  type: string;
  webhookEventId?: string;
  replyToken?: string;
  postback?: { data?: string };
  source?: { type: string; userId?: string };
  message?: { id: string; type: string; text?: string; markAsReadToken?: string; fileName?: string; fileSize?: number };
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
    // ระบบนัด: ปุ่มยืนยัน/ขอเลื่อน และรหัสจากใบนัด ไม่ผ่าน AI ทุกโหมด
    if (userId && ev.source?.type === "user" && (await handleAppointmentEvent(ev, userId))) continue;
    if (ev.type !== "message" || !userId || ev.source?.type !== "user" || !ev.message) continue;

    const isImage = ev.message.type === "image";
    // ไฟล์: รับ PDF ไม่เกิน 25MB ไฟล์ชนิดอื่นให้เจ้าหน้าที่เปิดดูใน LINE OA
    const isFile = ev.message.type === "file";
    const isPdf = isFile && isPdfName(ev.message.fileName) && (ev.message.fileSize ?? 0) <= MAX_FILE_BYTES;
    const fileName = sanitizeFileName(ev.message.fileName);
    // รองรับข้อความ รูป และ PDF ประเภทอื่นบันทึกเป็นข้อความแจ้งเตือน
    const text = ev.message.type === "text"
      ? ev.message.text ?? ""
      : isImage || isPdf ? ""
      : isFile ? `[ลูกค้าส่งไฟล์ ${(ev.message.fileName ?? "").slice(0, 120)} — เปิดดูใน LINE OA]`
      : `[ลูกค้าส่ง ${ev.message.type} — เปิดดูใน LINE OA]`;

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
      file: isPdf ? { name: fileName, size: ev.message.fileSize ?? null } : undefined,
    });

    if (stored.duplicate) continue;
    if (isImage) {
      const content = lineContentRequest(ev.message.id);
      after(() => ingestInboundImage(stored.messageId, () => downloadLimited(content.url, content.headers)));
    } else if (isPdf) {
      const content = lineContentRequest(ev.message.id);
      after(() => ingestInboundFile(stored.messageId, () => downloadLimited(content.url, content.headers, MAX_FILE_BYTES), fileName,
        "[ลูกค้าส่งไฟล์ — โหลดไม่สำเร็จ เปิดดูใน LINE OA]"));
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

/** คืน true ถ้าเป็นของระบบนัด พลาดต้องไม่ทำให้ event อื่นหาย และ LINE ไม่ต้องส่งซ้ำเพราะกันซ้ำด้วย id อยู่แล้ว */
async function handleAppointmentEvent(ev: LineEvent, userId: string): Promise<boolean> {
  const postback = ev.type === "postback" && parseAppointmentPostback(ev.postback?.data) ? (ev.postback?.data as string) : null;
  const text = ev.type === "message" && ev.message?.type === "text" ? ev.message.text ?? "" : "";
  const code = text ? parseLinkCode(text) : null;
  if (!postback && !code) return false;
  try {
    const profile = await getLineProfile(userId);
    const ref = {
      channelType: "line" as const, externalId: userId, replyToken: ev.replyToken,
      displayName: profile.displayName, avatarUrl: profile.pictureUrl,
      eventId: postback ? `line-pb:${ev.webhookEventId ?? `${userId}:${postback}:${Date.now()}`}` : (ev.message as { id: string }).id,
    };
    if (postback) await handleAppointmentPostback(ref, postback, "");
    else await handleLinkCode(ref, text, code as string);
  } catch (e) {
    console.error("appointment webhook failed", e);
    await logSystemError("webhook:line:appointment", e);
  }
  return true;
}
