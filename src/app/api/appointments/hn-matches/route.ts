import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { listHnMatches } from "@/lib/appointment-store";

export const runtime = "nodejs";

/** ข้อเสนอจับคู่ HN ของคนไข้ใหม่ที่รอแอดมินยืนยัน */
export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  return NextResponse.json({ matches: await listHnMatches() }, { headers: { "Cache-Control": "no-store" } });
}
