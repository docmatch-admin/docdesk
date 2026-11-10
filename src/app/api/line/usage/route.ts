import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { lineUsage } from "@/lib/line-usage";

export const runtime = "nodejs";

/** สรุปการใช้ LINE เดือนนี้: push แยกประเภท reply ที่ใช้ไป เทียบโควตาจาก LINE
 * agent เห็นแบบอ่านอย่างเดียวในหน้าตั้งค่า (ห้องยาไม่เห็น) */
export async function GET() {
  const { error } = await requireStaff();
  if (error) return error;
  return NextResponse.json(await lineUsage(), { headers: { "Cache-Control": "no-store" } });
}
