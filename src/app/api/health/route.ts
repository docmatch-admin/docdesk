import { NextResponse } from "next/server";
import { runHealthChecks } from "@/lib/health";

export const runtime = "nodejs";
export const maxDuration = 60;

/** pg_cron เรียกทุก 5 นาที ผิดปกติตอบ 503 ให้เห็นใน log ของ cron ได้ */
export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const checks = await runHealthChecks(new URL(req.url).origin);
  const ok = checks.every((c) => c.ok);
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}
