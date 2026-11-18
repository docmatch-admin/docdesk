import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { logSystemError, touchHeartbeat } from "@/lib/health";
import { runLabSync } from "@/lib/lab-results-store";

export const runtime = "nodejs";
export const maxDuration = 60;

/** header x-lab-sync-secret ต้องตรงกับ env LAB_SYNC_SECRET (แยกจาก CRON_SECRET) · ไม่ได้ตั้ง env = ปิด */
function authorized(req: Request): boolean {
  const secret = process.env.LAB_SYNC_SECRET;
  const got = req.headers.get("x-lab-sync-secret");
  if (!secret || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Supabase pg_cron + pg_net เรียกชั่วโมงละครั้ง 13:00–18:00 น. (Vercel Hobby ทำ cron ถี่ไม่ได้)
 * ดึงผลใหม่/ฉบับแก้จาก Bangkok Medical Lab (อ่านอย่างเดียว) → เก็บ PDF → จับคู่ HN → แจ้งคนไข้ทาง LINE ทันที + แจ้งทีม
 */
async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await touchHeartbeat("cron_lab_results").catch((e) => console.error("heartbeat failed", e));
  try {
    const result = await runLabSync();
    if (result.skipped === "not_configured") return NextResponse.json({ ...result, error: "ยังไม่ได้ตั้ง BML_USERNAME / BML_PASSWORD" }, { status: 503 });
    return NextResponse.json(result);
  } catch (e) {
    console.error("lab sync failed", e instanceof Error ? e.message : e);
    await logSystemError("cron:lab-results", e);
    return NextResponse.json({ error: "ดึงผลแล็บไม่สำเร็จ" }, { status: 502 });
  }
}

export const GET = handle;
export const POST = handle;
