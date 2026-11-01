import { after, NextResponse } from "next/server";
import { getMetaProfile, parseMetaWebhook, verifyMetaSignature } from "@/lib/channels/meta";
import { processIncoming, storeIncoming } from "@/lib/pipeline";
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

  const incoming = parseMetaWebhook(JSON.parse(raw));
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
    });

    if (!stored.duplicate && m.isText) {
      after(() => processIncoming(stored.conversationId).catch((e) => console.error("processIncoming", e)));
    }
  }

  // Meta ต้องการ 200 ภายในไม่กี่วินาที ไม่งั้นจะส่งซ้ำ
  return NextResponse.json({ ok: true });
}
