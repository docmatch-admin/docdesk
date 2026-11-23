import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { visitHistoryOf } from "@/lib/visit-history";

export const runtime = "nodejs";

/** ประวัติการมาตรวจของคนไข้ที่ผูกกับแชท (เจ้าหน้าที่เท่านั้น แชทลับต้องมีสิทธิ์) */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  return NextResponse.json(await visitHistoryOf(id), { headers: { "Cache-Control": "no-store" } });
}
