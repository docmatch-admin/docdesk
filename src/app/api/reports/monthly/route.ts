import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { monthlySummary } from "@/lib/retention-store";

export const runtime = "nodejs";

/** สรุปรายเดือน (admin): งานที่เสร็จต่อผู้รับ นัดยกเลิกต่อเหตุผลยกเลิก/เหตุผลนัด รวมตัวเลขของแถวที่ลบตามนโยบายเก็บข้อมูลแล้ว */
export async function GET(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const month = new URL(req.url).searchParams.get("month") ?? "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return NextResponse.json({ error: "month ต้องเป็น YYYY-MM" }, { status: 400 });
  return NextResponse.json(await monthlySummary(month), { headers: { "Cache-Control": "no-store" } });
}
