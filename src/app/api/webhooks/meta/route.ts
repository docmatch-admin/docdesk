import { after, NextResponse } from "next/server";
import { getMetaProfile, META_FALLBACK_NAME, parseMetaEchoes, parseMetaPostbacks, parseMetaReads, parseMetaWebhook, verifyMetaSignature } from "@/lib/channels/meta";
import { parseLinkCode } from "@/lib/appointment-rules";
import { handleAppointmentPostback, handleLinkCode } from "@/lib/appointment-store";
import { logSystemError } from "@/lib/health";
import { downloadLimited } from "@/lib/media";
import { fileNameFromUrl, MAX_FILE_BYTES } from "@/lib/files";
import { ingestInboundFile, ingestInboundImage } from "@/lib/media-store";
import { processIncoming, storeIncoming, storeMetaEcho } from "@/lib/pipeline";
import { applyCustomerRead, findConversationId } from "@/lib/read-receipts";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Meta ยืนยัน webhook ตอนกด Verify and save ในหน้า App Dashboard */
export function GET(req: Request) {
  const u = new URL(req.url);
  const ok = u.searchParams.get("hub.mode") === "subscribe"
    && !!process.env.META_VERIFY_TOKEN
    && u.searchParams.get("hub.verify_token") === process.env.META_VERIFY_TOKEN;
  return ok
    ? new NextResponse(u.searchParams.get("hub.challenge") ?? "", { status: 200 })
    : new NextResponse("forbidden", { status: 403 });
}

/** ข้อความเข้าจาก Facebook Messenger (object=page) และ Instagram (object=instagram) */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  const body = JSON.parse(raw);
  const incoming = parseMetaWebhook(body);
  try {
  for (const m of incoming) {
    // ดึงโปรไฟล์เฉพาะลูกค้าใหม่ (ประหยัดการเรียก API)
    const { data: known } = await supabaseAdmin().from("contacts")
      .select("id, platform_name, channels!inner(type)")
      .eq("external_id", m.senderId).eq("channels.type", m.kind).maybeSingle();
    // ยังไม่มีชื่อแพลตฟอร์มจริง (ชื่อชั่วคราว หรือรายชื่อเก่าก่อนมี platform_name) ลองดึงใหม่
    const profile = known?.platform_name && known.platform_name !== META_FALLBACK_NAME[m.kind] ? {} : await getMetaProfile(m.kind, m.senderId);

    // รหัสจากใบนัด: ระบบนัดตอบเอง AI ไม่ตอบทับ
    const code = m.isText ? parseLinkCode(m.text) : null;
    if (code) {
      try {
        await handleLinkCode({ channelType: m.kind, externalId: m.senderId, eventId: m.messageId, displayName: profile.name, avatarUrl: profile.avatar }, m.text, code);
      } catch (e) {
        console.error("appointment link failed", e);
        await logSystemError("webhook:meta:appointment", e);
      }
      continue;
    }

    const stored = await storeIncoming({
      channelType: m.kind,
      externalId: m.senderId,
      text: m.text,
      displayName: profile.name,
      avatarUrl: profile.avatar,
      externalMessageId: m.messageId,
      isImage: !!m.imageUrl,
      file: m.fileUrl ? { name: fileNameFromUrl(m.fileUrl) } : undefined,
    });

    if (!stored.duplicate && m.imageUrl) {
      const url = m.imageUrl;
      after(() => ingestInboundImage(stored.messageId, () => downloadLimited(url)));
    } else if (!stored.duplicate && m.fileUrl) {
      const url = m.fileUrl;
      const app = m.kind === "facebook" ? "Meta Business Suite" : "Instagram";
      after(() => ingestInboundFile(stored.messageId, () => downloadLimited(url, {}, MAX_FILE_BYTES), fileNameFromUrl(url),
        `[ลูกค้าส่งไฟล์ที่ไม่ใช่ PDF หรือโหลดไม่สำเร็จ — เปิดดูใน ${app}]`));
    } else if (!stored.duplicate && m.isText) {
      after(() => processIncoming(stored.conversationId, stored.messageId).catch((e) => {
        console.error("processIncoming", e);
        return logSystemError("ai:auto-reply", e);
      }));
    }
  }
  } catch (e) {
    await logSystemError("webhook:meta", e);
    throw e;
  }

  // ปุ่มของระบบนัด (postback ของ Facebook, quick reply ของ Instagram)
  for (const pb of parseMetaPostbacks(body)) {
    try {
      const { data: known } = await supabaseAdmin().from("contacts")
        .select("id, channels!inner(type)").eq("external_id", pb.senderId).eq("channels.type", pb.kind).maybeSingle();
      const profile = known ? {} : await getMetaProfile(pb.kind, pb.senderId);
      await handleAppointmentPostback({ channelType: pb.kind, externalId: pb.senderId, eventId: pb.eventId, displayName: profile.name, avatarUrl: profile.avatar }, pb.payload, pb.title);
    } catch (e) {
      console.error("appointment postback failed", e);
      await logSystemError("webhook:meta:appointment", e);
    }
  }

  // ข้อความที่เพจส่งออก (message_echoes) พลาดรายการเดียวต้องไม่ทำให้รายการอื่นหาย
  for (const echo of parseMetaEchoes(body)) {
    try {
      const { data: known } = await supabaseAdmin().from("contacts")
        .select("id, channels!inner(type)").eq("external_id", echo.customerId).eq("channels.type", echo.kind).maybeSingle();
      const name = known ? undefined : (await getMetaProfile(echo.kind, echo.customerId)).name;
      await storeMetaEcho(echo, name);
    } catch (e) {
      console.error("meta echo failed", e);
      await logSystemError("webhook:meta", e);
    }
  }

  // ลูกค้าอ่านข้อความแล้ว
  for (const r of parseMetaReads(body)) {
    try {
      const db = supabaseAdmin();
      const conversationId = await findConversationId(db, r.kind, r.senderId);
      if (conversationId) await applyCustomerRead(db, conversationId, new Date(r.watermark).toISOString(), new Date(r.readAt));
    } catch (e) {
      console.error("meta read failed", e);
      await logSystemError("webhook:meta", e);
    }
  }

  // Meta ต้องการ 200 ภายในไม่กี่วินาที ไม่งั้นจะส่งซ้ำ
  return NextResponse.json({ ok: true });
}
