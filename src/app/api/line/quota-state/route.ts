import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { lineQuotaState } from "@/lib/line-quota";

export const runtime = "nodejs";

/** สถานะโควตา LINE สำหรับแถบบนทุกหน้า (เจ้าหน้าที่ทุกตำแหน่ง) */
export async function GET() {
  const { error } = await requireAppointmentStaff();
  if (error) return error;
  return NextResponse.json(await lineQuotaState(), { headers: { "Cache-Control": "no-store" } });
}
