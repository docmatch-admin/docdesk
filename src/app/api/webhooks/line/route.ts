import { after, NextResponse } from "next/server";
import { getLineProfile, verifyLineSignature } from "@/lib/channels/line";
import { processIncoming, storeIncoming } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { type: string; userId?: string };
  message?: { id: string; type: string; text?: string };
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyLineSignature(raw, req.headers.get("x-line-signature"))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const { events = [] } = JSON.parse(raw) as { events: LineEvent[] };

  for (const ev of events) {
    const userId = ev.source?.userId;
    if (ev.type !== "message" || !userId || ev.source?.type !== "user" || !ev.message) continue;

    // เฟสแรกรองรับข้อความตัวอักษร ประเภทอื่นบันทึกเป็นข้อความแจ้งเตือน
    const text = ev.message.type === "text"
      ? ev.message.text ?? ""
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
    });

    if (!stored.duplicate && ev.message.type === "text") {
      after(() => processIncoming(stored.conversationId, ev.replyToken).catch((e) => console.error("processIncoming", e)));
    }
  }

  return NextResponse.json({ ok: true });
}
