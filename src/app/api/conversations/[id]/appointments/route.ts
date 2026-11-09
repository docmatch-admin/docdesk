import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { APPOINTMENT_COLUMNS } from "@/lib/appointment-store";
import { bangkokToday, type Appointment } from "@/lib/appointment-rules";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const OPEN = ["scheduled", "confirmed", "reschedule_requested"];

/**
 * กล่องขวาของแชท: นัดที่กำลังจะมาถึงของคนไข้ที่ผูก HN กับแชทนี้ (ทุกนัดของ HN นั้น ไม่ว่าทำจากหน้าไหน)
 * รวมนัดที่ผูกกับแชทนี้โดยตรง (คนไข้ใหม่ที่ยังไม่มี HN) และ HN ที่ผูกไว้ใช้เติมฟอร์ม
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const db = supabaseAdmin();
  const today = bangkokToday();
  const { data: link } = await db.from("patient_links").select("hn, patient_name, phone").eq("conversation_id", id).maybeSingle();
  const [{ data: byChat }, { data: byHn }] = await Promise.all([
    db.from("appointments").select(APPOINTMENT_COLUMNS).eq("conversation_id", id).gte("appoint_date", today).in("status", OPEN),
    link?.hn
      ? db.from("appointments").select(APPOINTMENT_COLUMNS).eq("hn", link.hn as string).gte("appoint_date", today).in("status", OPEN)
      : Promise.resolve({ data: [] }),
  ]);
  const seen = new Set<string>();
  const appointments = ([...(byChat ?? []), ...(byHn ?? [])] as unknown as Appointment[])
    .filter((a) => !a.series_done && !seen.has(a.id) && seen.add(a.id))
    .sort((a, b) => a.appoint_date.localeCompare(b.appoint_date) || a.time_start.localeCompare(b.time_start));
  return NextResponse.json({ link: link ?? null, appointments }, { headers: { "Cache-Control": "no-store" } });
}
