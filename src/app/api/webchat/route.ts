import { after, NextResponse } from "next/server";
import { attachWidgetMedia } from "@/lib/media-store";
import { processIncoming, storeIncoming } from "@/lib/pipeline";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { admitWebchat, clientIp, corsHeaders, hashIp, isAllowedOrigin, type WebchatAdmission } from "@/lib/webchat-guard";

export const runtime = "nodejs";
export const maxDuration = 60;

const SESSION_RE = /^[0-9a-f-]{36}$/i;

const forbidden = (cors: Record<string, string>) =>
  NextResponse.json({ error: "forbidden" }, { status: 403, headers: cors });

export function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new NextResponse(null, { status: isAllowedOrigin(origin) ? 204 : 403, headers: corsHeaders(origin) });
}

/** ลูกค้าบนเว็บส่งข้อความ */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (!isAllowedOrigin(origin)) return forbidden(cors);

  const { session, text, name } = (await req.json().catch(() => ({}))) as { session?: string; text?: string; name?: string };
  if (!session || !SESSION_RE.test(session) || !text?.trim()) {
    return NextResponse.json({ error: "invalid" }, { status: 400, headers: cors });
  }

  const db = supabaseAdmin();
  let admission: WebchatAdmission;
  try {
    admission = await admitWebchat(db, session, hashIp(clientIp(req.headers)));
  } catch (e) {
    // ตรวจเพดานไม่ได้ = ไม่เสี่ยงเรียก AI
    console.error("webchat admit failed", e);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: cors });
  }
  if (!admission.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: cors });
  }

  const stored = await storeIncoming({
    channelType: "web",
    externalId: session,
    text: text.trim().slice(0, 2000),
    displayName: name?.trim().slice(0, 60) || undefined,
    skipAi: !admission.ai_allowed,
  });
  if (!stored.duplicate) {
    if (admission.ai_allowed) {
      after(() => processIncoming(stored.conversationId, stored.messageId).catch((e) => console.error("processIncoming", e)));
    } else {
      // เกินเพดาน AI รายวัน: เก็บข้อความไว้ให้เจ้าหน้าที่ตอบเอง
      await db.from("conversations").update({ needs_human: true, ai_due_at: null }).eq("id", stored.conversationId);
    }
  }
  return NextResponse.json({ ok: true, id: stored.messageId }, { headers: cors });
}

/** widget ดึงข้อความ (polling) — คืนเฉพาะข้อความในแชทของ session นี้ */
export async function GET(req: Request) {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (!isAllowedOrigin(origin)) return forbidden(cors);

  const url = new URL(req.url);
  const session = url.searchParams.get("session") ?? "";
  const after_ = url.searchParams.get("after");
  if (!SESSION_RE.test(session)) return NextResponse.json({ messages: [] }, { headers: cors });

  const db = supabaseAdmin();
  const { data: channel } = await db.from("channels").select("id").eq("type", "web").limit(1).maybeSingle();
  if (!channel) return NextResponse.json({ messages: [] }, { headers: cors });
  const { data: contact } = await db.from("contacts").select("id")
    .eq("channel_id", channel.id).eq("external_id", session).maybeSingle();
  if (!contact) return NextResponse.json({ messages: [] }, { headers: cors });
  const { data: conv } = await db.from("conversations").select("id, customer_marked_read_at").eq("contact_id", contact.id).maybeSingle();
  if (!conv) return NextResponse.json({ messages: [] }, { headers: cors });

  let q = db.from("messages").select("id, direction, body, created_at, media_path, media_preview_path, media_deleted_at")
    .eq("conversation_id", conv.id).order("created_at").limit(100);
  if (after_) q = q.gt("created_at", after_);
  const { data } = await q;
  return NextResponse.json({ messages: await attachWidgetMedia(data ?? []), clinic_read_at: conv.customer_marked_read_at }, { headers: cors });
}
