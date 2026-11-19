import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { bangkokDaysAgo, importReceiptPatients } from "@/lib/receipt-patients";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * นำเข้าชื่อคนไข้จากระบบใบเสร็จ → patients (ค้นด้วยชื่อตอนทำนัด)
 * - pg_cron ทุกคืน 02:00: Authorization: Bearer CRON_SECRET (Vault docdesk_cron_secret) → ย้อนหลัง 3 วัน
 * - แอดมินกดเอง / ครั้งแรก: ?full=1 = ดึงทั้งหมด
 */
export async function POST(req: Request) {
  const cron = !!process.env.CRON_SECRET && req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!cron) {
    const { error } = await requireAdmin();
    if (error) return error;
  }
  const u = new URL(req.url).searchParams;
  const since = u.get("full") ? null : bangkokDaysAgo(Number(u.get("days")) || 3);
  try {
    return NextResponse.json(await importReceiptPatients(since), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("receipt patient import failed", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
