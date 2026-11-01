import { after, NextResponse } from "next/server";
import { getMetaProfile, parseMetaReads, parseMetaWebhook, verifyMetaSignature } from "@/lib/channels/meta";
import { downloadLimited } from "@/lib/media";
import { ingestInboundImage } from "@/lib/media-store";
import { processIncoming, storeIncoming } from "@/lib/pipeline";
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
  for (const m of incoming) {
    // ดึงโปรไฟล์เฉพาะลูกค้าใหม่ (ประหยัดการเรียก API)
    const { data: known } = await supabaseAdmin().from("contacts")
      .select("id, display_name, channels!inner(type)")
      .eq("external_id", m.senderId).eq("channels.type", m.kind).maybeSingle();
    const profile = known?.display_name ? {} : await getMetaProfile(m.kind, m.senderId);

    const stored = await storeIncoming({
      channelType: m.kind,
      externalId: m.senderId,
      text: m.text,
      displayName: profile.name,
      avatarUrl: profile.avatar,
      externalMessageId: m.messageId,
      isImage: !!m.imageUrl,
    });

    if (!stored.duplicate && m.imageUrl) {
      const url = m.imageUrl;
      after(() => ingestInboundImage(stored.messageId, () => downloadLimited(url)));
    } else if (!stored.duplicate && m.isText) {
      after(() => processIncoming(stored.conversationId, stored.messageId).catch((e) => console.error("processIncoming", e)));
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
    }
  }

  // Meta ต้องการ 200 ภายในไม่กี่วินาที ไม่งั้นจะส่งซ้ำ
  return NextResponse.json({ ok: true });
}
