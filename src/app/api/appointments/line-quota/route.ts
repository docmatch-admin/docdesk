import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { lineQuota } from "@/lib/channels/line";

export const runtime = "nodejs";

/** โควตาข้อความ LINE ที่ใช้ไปเดือนนี้ */
export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  try {
    return NextResponse.json(await lineQuota(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("line quota failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "อ่านโควตา LINE ไม่สำเร็จ" }, { status: 502 });
  }
}
