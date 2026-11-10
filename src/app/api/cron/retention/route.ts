import { NextResponse } from "next/server";
import { logSystemError, touchHeartbeat } from "@/lib/health";
import { runRetention } from "@/lib/retention-store";

export const runtime = "nodejs";
export const maxDuration = 60;

/** pg_cron วันละครั้ง 03:00 เวลาไทย: ลบงานที่เสร็จแล้วและนัดที่ยกเลิกที่พ้นระยะเก็บ (ชุดละ ≤ 500 แถว) */
async function handle(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await touchHeartbeat("cron_retention").catch((e) => console.error("heartbeat failed", e));
  const result = await runRetention();
  if (result.error) await logSystemError("cron:retention", new Error(result.error));
  return NextResponse.json(result, { status: result.error ? 500 : 200 });
}

export const GET = handle;
export const POST = handle;
