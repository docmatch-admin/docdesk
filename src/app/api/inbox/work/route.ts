import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { queueBadge } from "@/lib/inbox-list";
import { inboxCounts, inboxWork } from "@/lib/inbox-work";
import { serverTiming } from "@/lib/server-timing";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * งานค้างของแต่ละแชท (ช่วง "งานค้าง") + ตัวเลข badge เมนูแชท ในครั้งเดียว
 * ?counts=1 = เฉพาะตัวเลข badge (มี migration 063 = query เดียวจากคอลัมน์ queue)
 */
export async function GET(req: Request) {
  const t = serverTiming();
  const { error } = await t.time("auth", requireStaff());
  if (error) return error;
  if (new URL(req.url).searchParams.get("counts")) {
    const quick = await t.time("queue", queueBadge(supabaseAdmin() as never));
    const counts = quick ?? await t.time("counts", inboxCounts());
    return NextResponse.json({ counts }, { headers: t.headers() });
  }
  const work = await t.time("work", inboxWork());
  const counts = await t.time("counts", inboxCounts(Date.now(), work));
  return NextResponse.json({ work, counts }, { headers: t.headers() });
}
