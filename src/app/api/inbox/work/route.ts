import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { inboxCounts, inboxWork } from "@/lib/inbox-work";

export const runtime = "nodejs";

/** งานค้างของแต่ละแชท (ช่วง "งานค้าง") · ?counts=1 = ตัวเลข badge เมนูแชท (รอตอบ + งานค้าง) */
export async function GET(req: Request) {
  const { error } = await requireStaff();
  if (error) return error;
  const noStore = { headers: { "Cache-Control": "no-store" } };
  if (new URL(req.url).searchParams.get("counts")) return NextResponse.json({ counts: await inboxCounts() }, noStore);
  return NextResponse.json({ work: await inboxWork() }, noStore);
}
