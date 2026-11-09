import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { lineUsage } from "@/lib/line-usage";

export const runtime = "nodejs";

/** สรุปการใช้ LINE เดือนนี้: push แยกประเภท reply ที่ใช้ไป เทียบโควตาจาก LINE */
export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  return NextResponse.json(await lineUsage(), { headers: { "Cache-Control": "no-store" } });
}
