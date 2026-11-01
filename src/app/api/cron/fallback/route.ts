import { NextResponse } from "next/server";
import { purgeExpiredMedia, purgeStaleUploads } from "@/lib/media-store";
import { runFallback } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

async function handle(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runFallback();
  // ลบรูปพลาดรอบนี้ไม่เป็นไร รอบหน้าลองใหม่ ต้องไม่กระทบ AI ที่ตอบแทน
  let mediaPurged = 0;
  try {
    mediaPurged = await purgeExpiredMedia();
    await purgeStaleUploads();
  } catch (e) {
    console.error("media purge failed", e);
  }
  return NextResponse.json({ ...result, mediaPurged });
}

export const GET = handle;
export const POST = handle;
