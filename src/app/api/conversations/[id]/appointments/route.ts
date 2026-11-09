import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { APPOINTMENT_COLUMNS, linkedAccounts } from "@/lib/appointment-store";
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
  // ทุกนัดของแชทนี้และของ HN ที่ผูก: ที่ยังไม่ถึงเรียงใกล้สุดก่อน ที่ผ่านแล้ว/ปิดแล้วย่อไว้ (ใหม่สุดก่อน)
  const [{ data: byChat }, { data: byHn }] = await Promise.all([
    db.from("appointments").select(APPOINTMENT_COLUMNS).eq("conversation_id", id).order("appoint_date", { ascending: false }).limit(60),
    link?.hn
      ? db.from("appointments").select(APPOINTMENT_COLUMNS).eq("hn", link.hn as string).order("appoint_date", { ascending: false }).limit(60)
      : Promise.resolve({ data: [] }),
  ]);
  const seen = new Set<string>();
  const all = ([...(byChat ?? []), ...(byHn ?? [])] as unknown as Appointment[])
    .filter((a) => !a.series_done && !seen.has(a.id) && seen.add(a.id));
  const isUpcoming = (a: Appointment) => a.appoint_date >= today && OPEN.includes(a.status);
  const appointments = all.filter(isUpcoming)
    .sort((a, b) => a.appoint_date.localeCompare(b.appoint_date) || a.time_start.localeCompare(b.time_start));
  const past = all.filter((a) => !isUpcoming(a))
    .sort((a, b) => b.appoint_date.localeCompare(a.appoint_date) || b.time_start.localeCompare(a.time_start)).slice(0, 20);
  // บัญชีที่ผูก HN นี้ (คนไข้ + ญาติ) ใช้ดู/แก้ป้าย/ยกเลิกการผูกรายบัญชี
  const accounts = link?.hn ? await linkedAccounts({ id: "00000000-0000-0000-0000-000000000000", hn: link.hn as string, conversation_id: null }) : [];
  return NextResponse.json({ link: link ?? null, appointments, past, accounts }, { headers: { "Cache-Control": "no-store" } });
}
