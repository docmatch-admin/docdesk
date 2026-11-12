import { NextResponse } from "next/server";
import { logSystemError, touchHeartbeat } from "@/lib/health";
import { sendChatKpi } from "@/lib/hr-kpi";
import { bangkokYesterday, isKpiDate } from "@/lib/hr-kpi-rules";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Vercel Cron วันละครั้ง 01:00 น. ไทย (18:00 UTC): ส่งคะแนนตอบแชทของ "เมื่อวาน" เข้าระบบ HR
 * ส่งย้อนหลังได้ด้วย ?date=YYYY-MM-DD (ส่งซ้ำวันเดิม HR เขียนทับ)
 */
async function handle(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const param = new URL(req.url).searchParams.get("date");
  if (param !== null && !isKpiDate(param)) return NextResponse.json({ error: "date ต้องเป็น YYYY-MM-DD" }, { status: 400 });
  const date = param ?? bangkokYesterday();

  await touchHeartbeat("cron_hr_kpi").catch((e) => console.error("heartbeat failed", e));
  try {
    const result = await sendChatKpi(date);
    if (result.error) await logSystemError("cron:hr-kpi", new Error(result.error));
    return NextResponse.json(result, { status: result.error ? 502 : 200 });
  } catch (e) {
    console.error("hr-kpi failed", e);
    await logSystemError("cron:hr-kpi", e);
    return NextResponse.json({ date, error: "ส่งคะแนนเข้า HR ไม่สำเร็จ" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
