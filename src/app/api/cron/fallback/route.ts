import { NextResponse } from "next/server";
import { pushPendingBookings } from "@/lib/booking-store";
import { touchHeartbeat } from "@/lib/health";
import { purgeExpiredMedia, purgeStaleUploads } from "@/lib/media-store";
import { autoCloseQuietChats, runFallback } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

async function handle(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // บันทึกก่อนงานอื่น cron ที่รันแต่งานล้มเหลวไม่ได้แปลว่า cron หยุด
  await touchHeartbeat("cron_fallback").catch((e) => console.error("heartbeat failed", e));
  const result = await runFallback();
  // ลบรูปพลาดรอบนี้ไม่เป็นไร รอบหน้าลองใหม่ ต้องไม่กระทบ AI ที่ตอบแทน
  let mediaPurged = 0;
  try {
    mediaPurged = await purgeExpiredMedia();
    await purgeStaleUploads();
  } catch (e) {
    console.error("media purge failed", e);
  }
  let autoClosed = 0;
  try {
    autoClosed = await autoCloseQuietChats();
  } catch (e) {
    console.error("auto close failed", e);
  }
  let pushed = 0;
  try {
    pushed = await pushPendingBookings();
  } catch (e) {
    console.error("booking push failed", e);
  }
  return NextResponse.json({ ...result, mediaPurged, autoClosed, pushed });
}

export const GET = handle;
export const POST = handle;
