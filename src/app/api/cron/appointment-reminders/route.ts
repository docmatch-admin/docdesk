import { NextResponse } from "next/server";
import { runAppointmentReminders } from "@/lib/appointment-store";
import { logSystemError, touchHeartbeat } from "@/lib/health";

export const runtime = "nodejs";
export const maxDuration = 60;

/** pg_cron เรียกทุก 15 นาที ส่งเตือนวันก่อนนัดเมื่อถึง reminder_time */
async function handle(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await touchHeartbeat("cron_appointment_reminders").catch((e) => console.error("heartbeat failed", e));
  try {
    return NextResponse.json(await runAppointmentReminders());
  } catch (e) {
    await logSystemError("cron:appointment-reminders", e);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
