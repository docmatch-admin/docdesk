import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { inboxCounts, inboxWork } from "@/lib/inbox-work";
import { serverTiming } from "@/lib/server-timing";

export const runtime = "nodejs";

/**
 * งานค้างของแต่ละแชท (ช่วง "งานค้าง") + ตัวเลข badge เมนูแชท ในครั้งเดียว
 * (รายการแชทกับ badge ใช้ผลเดียวกัน) · ?counts=1 = เฉพาะตัวเลข badge
 */
export async function GET(req: Request) {
  const t = serverTiming();
  const { error } = await t.time("auth", requireStaff());
  if (error) return error;
  const work = await t.time("work", inboxWork());
  const counts = await t.time("counts", inboxCounts(Date.now(), work));
  if (new URL(req.url).searchParams.get("counts")) return NextResponse.json({ counts }, { headers: t.headers() });
  return NextResponse.json({ work, counts }, { headers: t.headers() });
}
