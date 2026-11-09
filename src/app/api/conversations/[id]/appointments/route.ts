import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { APPOINTMENT_COLUMNS } from "@/lib/appointment-store";
import { bangkokToday } from "@/lib/appointment-rules";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** กล่องขวาของแชท: นัดที่กำลังจะมาถึง และ HN ที่ผูกไว้ใช้เติมฟอร์ม */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const db = supabaseAdmin();
  const [{ data: link }, { data: rows }] = await Promise.all([
    db.from("patient_links").select("hn, patient_name, phone").eq("conversation_id", id).maybeSingle(),
    db.from("appointments").select(APPOINTMENT_COLUMNS).eq("conversation_id", id).gte("appoint_date", bangkokToday())
      .in("status", ["scheduled", "confirmed", "reschedule_requested"]).order("appoint_date").order("appoint_time"),
  ]);
  return NextResponse.json({ link: link ?? null, appointments: rows ?? [] }, { headers: { "Cache-Control": "no-store" } });
}
