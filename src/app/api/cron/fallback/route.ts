import { NextResponse } from "next/server";
import { runFallback } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

async function handle(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runFallback());
}

export const GET = handle;
export const POST = handle;
