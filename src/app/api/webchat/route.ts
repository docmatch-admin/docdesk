import { after, NextResponse } from "next/server";
import { processIncoming, storeIncoming } from "@/lib/pipeline";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const SESSION_RE = /^[0-9a-f-]{36}$/i;

export function OPTIONS() {
  return new NextResponse(null, { headers: cors });
}

/** ลูกค้าบนเว็บส่งข้อความ */
export async function POST(req: Request) {
  const { session, text, name } = (await req.json().catch(() => ({}))) as { session?: string; text?: string; name?: string };
  if (!session || !SESSION_RE.test(session) || !text?.trim()) {
    return NextResponse.json({ error: "invalid" }, { status: 400, headers: cors });
  }
  const stored = await storeIncoming({
    channelType: "web",
    externalId: session,
    text: text.trim().slice(0, 2000),
    displayName: name?.trim().slice(0, 60) || undefined,
  });
  if (!stored.duplicate) {
    after(() => processIncoming(stored.conversationId).catch((e) => console.error("processIncoming", e)));
  }
  return NextResponse.json({ ok: true, id: stored.messageId }, { headers: cors });
}

/** widget ดึงข้อความ (polling) — คืนเฉพาะข้อความในแชทของ session นี้ */
export async function GET(req: Request) {
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
  const { data: conv } = await db.from("conversations").select("id").eq("contact_id", contact.id).maybeSingle();
  if (!conv) return NextResponse.json({ messages: [] }, { headers: cors });

  let q = db.from("messages").select("id, direction, body, created_at")
    .eq("conversation_id", conv.id).order("created_at").limit(100);
  if (after_) q = q.gt("created_at", after_);
  const { data } = await q;
  return NextResponse.json({ messages: data ?? [] }, { headers: cors });
}
