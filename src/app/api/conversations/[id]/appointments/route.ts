import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { APPOINTMENT_COLUMNS, linkedAccounts } from "@/lib/appointment-store";
import { bangkokToday, type Appointment } from "@/lib/appointment-rules";
import { hnVariants, linksOfConversation, sameHn } from "@/lib/patient-link-store";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const OPEN = ["scheduled", "confirmed", "reschedule_requested"];
const NO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * กล่องขวาของแชท: นัดของทุก HN ที่ผูกกับแชท (บัญชี) นี้ แยกกลุ่มตามคนไข้
 * บัญชีเดียวผูกได้หลาย HN (ของตัวเอง + ญาติ) แต่ละกลุ่มมีบทบาทของบัญชีต่อ HN นั้น บัญชีที่รับแจ้งเตือน นัดที่ยังไม่ถึง และนัดที่ผ่านแล้ว
 * นัดที่ผูกกับแชทนี้โดยตรงแต่ไม่มี HN ที่ผูก (คนไข้ใหม่) อยู่กลุ่ม hn = null
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const db = supabaseAdmin();
  const today = bangkokToday();
  const [links, { data: conv }] = await Promise.all([
    linksOfConversation(id),
    db.from("conversations").select("contacts(hn)").eq("id", id).maybeSingle(),
  ]);
  const contact = (Array.isArray(conv?.contacts) ? conv?.contacts[0] : conv?.contacts) as { hn?: string | null } | null;
  const primaryHn = contact?.hn ?? null;

  const hns = [...new Set(links.flatMap((l) => hnVariants(l.hn)))];
  const [{ data: byChat }, { data: byHn }] = await Promise.all([
    db.from("appointments").select(APPOINTMENT_COLUMNS).eq("conversation_id", id).order("appoint_date", { ascending: false }).limit(60),
    hns.length
      ? db.from("appointments").select(APPOINTMENT_COLUMNS).in("hn", hns).order("appoint_date", { ascending: false }).limit(120)
      : Promise.resolve({ data: [] }),
  ]);
  const seen = new Set<string>();
  const all = ([...(byChat ?? []), ...(byHn ?? [])] as unknown as Appointment[])
    // นัดที่ยกเลิกไม่แสดงในกล่องขวา (ดูได้ในหน้านัดหมาย → ทั้งหมด → รวมยกเลิก)
    .filter((a) => !a.series_done && a.status !== "cancelled" && !seen.has(a.id) && seen.add(a.id));
  const isUpcoming = (a: Appointment) => a.appoint_date >= today && OPEN.includes(a.status);
  const split = (rows: Appointment[]) => ({
    upcoming: rows.filter(isUpcoming).sort((a, b) => a.appoint_date.localeCompare(b.appoint_date) || a.time_start.localeCompare(b.time_start)),
    past: rows.filter((a) => !isUpcoming(a)).sort((a, b) => b.appoint_date.localeCompare(a.appoint_date) || b.time_start.localeCompare(a.time_start)).slice(0, 20),
  });

  // กลุ่มต่อ HN: HN หลักก่อน แล้วของตัวเอง แล้วญาติ (ผูกล่าสุดก่อน)
  const ordered = [...links].sort((a, b) =>
    Number(sameHn(b.hn, primaryHn)) - Number(sameHn(a.hn, primaryHn))
    || Number(a.role === "relative") - Number(b.role === "relative")
    || b.linked_at.localeCompare(a.linked_at));
  const groups = await Promise.all(ordered.map(async (l) => ({
    hn: l.hn,
    name: l.patient_name,
    phone: l.phone,
    role: l.role,
    primary: sameHn(l.hn, primaryHn),
    accounts: await linkedAccounts({ id: NO_UUID, hn: l.hn, conversation_id: null }),
    ...split(all.filter((a) => sameHn(a.hn, l.hn))),
  })));
  const rest = all.filter((a) => !links.some((l) => sameHn(a.hn, l.hn)));
  if (rest.length) groups.push({ hn: null as unknown as string, name: null, phone: null, role: "patient", primary: false, accounts: [], ...split(rest) });

  const primary = ordered[0] ?? null;
  return NextResponse.json({
    groups,
    // ใช้กับโค้ดเดิม: HN หลัก
    link: primary ? { hn: primary.hn, patient_name: primary.patient_name, phone: primary.phone } : null,
  }, { headers: { "Cache-Control": "no-store" } });
}
