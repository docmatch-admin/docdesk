import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { saveSlipLang } from "@/lib/appointment-store";

export const runtime = "nodejs";

/** { lang: "th" | "en" } จำภาษาใบนัดที่เลือกล่าสุดของคนไข้ (patients.slip_lang) */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAppointmentStaff();
  if (error) return error;
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as { lang?: unknown };
  if (b.lang !== "th" && b.lang !== "en") return NextResponse.json({ error: "ภาษาไม่ถูกต้อง" }, { status: 400 });
  return NextResponse.json({ saved: await saveSlipLang(id, b.lang) });
}
