import { NextResponse } from "next/server";
import { applyCustomerRead, findConversationId } from "@/lib/read-receipts";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, isAllowedOrigin } from "@/lib/webchat-guard";

export const runtime = "nodejs";

const SESSION_RE = /^[0-9a-f-]{36}$/i;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;

export function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new NextResponse(null, { status: isAllowedOrigin(origin) ? 204 : 403, headers: corsHeaders(origin) });
}

/** ลูกค้าเปิดหน้าต่างแชทและเห็นข้อความถึงเวลา upTo แล้ว */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (!isAllowedOrigin(origin)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: cors });

  const { session, upTo } = (await req.json().catch(() => ({}))) as { session?: string; upTo?: string };
  if (!session || !SESSION_RE.test(session) || !upTo || !TIMESTAMP_RE.test(upTo) || Number.isNaN(Date.parse(upTo))) {
    return NextResponse.json({ error: "invalid" }, { status: 400, headers: cors });
  }

  try {
    const db = supabaseAdmin();
    const conversationId = await findConversationId(db, "web", session);
    if (conversationId) await applyCustomerRead(db, conversationId, upTo, new Date());
  } catch (e) {
    console.error("webchat seen failed", e);
  }
  return NextResponse.json({ ok: true }, { headers: cors });
}
