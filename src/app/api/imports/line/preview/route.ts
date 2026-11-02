import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { countOverlap, matchContacts } from "@/lib/line-import-store";
import { loadSensitiveKeywords } from "@/lib/sensitive-store";

export const runtime = "nodejs";

/** สรุปก่อนยืนยัน รับแค่ชื่อห้องกับเวลา ไม่รับเนื้อหาข้อความ */
export async function POST(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const { names, rooms } = (await req.json().catch(() => ({}))) as { names?: unknown; rooms?: unknown };
  if (!Array.isArray(names) || names.some((n) => typeof n !== "string") || names.length > 5000) {
    return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  }
  const matched = await matchContacts(names as string[]);
  const overlap = Array.isArray(rooms) ? await countOverlap(rooms as { name: string; times: string[] }[], matched) : 0;
  return NextResponse.json({ matched: [...matched.keys()], overlap, keywords: await loadSensitiveKeywords() });
}
