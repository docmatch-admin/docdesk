import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { clearPriceAlerts, runWebsiteSync } from "@/lib/website-sync";

export const runtime = "nodejs";
export const maxDuration = 60;

/** ปุ่ม "ซิงก์ราคาจากเว็บตอนนี้" force = admin ยืนยันว่าบริการหายจากเว็บจริง */
export async function POST(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const { force } = (await req.json().catch(() => ({}))) as { force?: boolean };
  const result = await runWebsiteSync({ force: force === true });
  return NextResponse.json(result, { status: result.ok || result.needs_confirm ? 200 : 502 });
}

/** รับทราบแจ้งเตือนราคาแพ็กเกจ */
export async function PATCH() {
  const { error } = await requireAdmin();
  if (error) return error;
  await clearPriceAlerts();
  return NextResponse.json({ ok: true });
}
