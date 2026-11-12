import { fetchHrEmployees, hrKpiEnabled, hrKpiUrl } from "./hr-sync";
import {
  bangkokDayRange, buildChatKpiRecords, HR_KPI_METRIC,
  type ChatKpiRecord, type KpiResponseEvent, type KpiStaff, type KpiStaffMessage,
} from "./hr-kpi-rules";
import { supabaseAdmin } from "./supabase/admin";

const PAGE = 1000;

async function fetchAll<T>(load: (from: number, to: number) => PromiseLike<{ data: unknown; error?: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await load(start, start + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** สถิติตอบแชทของวันนั้น (เวลาไทย) จากข้อมูลใน DocDesk */
export async function loadChatKpi(date: string): Promise<ChatKpiRecord[]> {
  const db = supabaseAdmin();
  const { from, to } = bangkokDayRange(date);
  const [messages, responses, { data: staff, error: staffError }, { data: auth }] = await Promise.all([
    // เฉพาะข้อความที่เจ้าหน้าที่ส่งเอง ไม่นับ AI / ระบบ / ประวัติที่นำเข้า
    fetchAll<KpiStaffMessage>((a, b) => db.from("messages").select("conversation_id, sender_id")
      .eq("direction", "out").eq("sender_type", "staff").neq("imported", true)
      .gte("created_at", from).lt("created_at", to).order("created_at").range(a, b)),
    fetchAll<KpiResponseEvent>((a, b) => db.from("response_events").select("replied_by, response_seconds")
      .gte("replied_at", from).lt("replied_at", to).order("replied_at").range(a, b)),
    db.from("staff").select("id, hr_employee_id"),
    db.auth.admin.listUsers({ perPage: 500 }),
  ]);
  if (staffError) throw staffError;
  const staffRows = (staff ?? []) as KpiStaff[];

  // จับคู่ HR ไว้แล้วส่งรหัสพนักงาน (HR ยังไม่มีอีเมลก็จับคู่ได้) · อ่านรายชื่อไม่ได้ ใช้อีเมลแทน ไม่ล้มทั้งชุด
  const hrCodes = new Map<string, string | null>();
  if (staffRows.some((s) => s.hr_employee_id)) {
    try {
      for (const e of await fetchHrEmployees()) hrCodes.set(e.id, e.employee_code);
    } catch (e) {
      console.error("hr-kpi: อ่านรายชื่อ HR ไม่สำเร็จ ใช้อีเมลแทน", e instanceof Error ? e.message : e);
    }
  }
  const emails = new Map((auth?.users ?? []).map((u) => [u.id, u.email ?? null]));
  return buildChatKpiRecords({ date, messages, responses, staff: staffRows, emails, hrCodes });
}

export interface HrKpiSendResult {
  date: string;
  sent: number;
  /** เจ้าหน้าที่ที่ HR หาไม่เจอ (ตามที่ HR ตอบกลับ) */
  unmatched: unknown[];
  error?: string;
}

/** ส่งของวันนั้นเข้า HR · ส่งซ้ำวันเดิมได้ HR เขียนทับ */
export async function sendChatKpi(date: string): Promise<HrKpiSendResult> {
  if (!hrKpiEnabled()) return { date, sent: 0, unmatched: [], error: "ยังไม่ได้ตั้ง HR_KPI_URL / HR_KPI_KEY" };
  const records = await loadChatKpi(date);
  if (!records.length) return { date, sent: 0, unmatched: [] };

  const res = await fetch(hrKpiUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.HR_KPI_KEY as string },
    body: JSON.stringify({ metric: HR_KPI_METRIC, records }),
    signal: AbortSignal.timeout(20000),
  });
  const body = (await res.json().catch(() => null)) as { unmatched?: unknown[]; error?: string } | null;
  if (!res.ok) return { date, sent: 0, unmatched: [], error: `HR ตอบกลับ ${res.status}${body?.error ? `: ${body.error}` : ""}` };
  const unmatched = Array.isArray(body?.unmatched) ? body.unmatched : [];
  if (unmatched.length) console.warn(`hr-kpi ${date}: HR หาเจ้าหน้าที่ไม่เจอ ${unmatched.length} คน`, JSON.stringify(unmatched));
  return { date, sent: records.length, unmatched };
}
