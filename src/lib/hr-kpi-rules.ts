// คะแนนตอบแชทรายวันของเจ้าหน้าที่ ส่งเข้าระบบ HR (metric "chat_reply") — ฟังก์ชันล้วน ไม่แตะฐานข้อมูล

export const HR_KPI_METRIC = "chat_reply";
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** วันที่ (YYYY-MM-DD) ตามเวลาไทย */
export const bangkokDate = (now: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));

/** "เมื่อวาน" ตามเวลาไทย: cron 01:00 น. ไทย ส่งของวันก่อนหน้าที่จบไปแล้ว */
export const bangkokYesterday = (now = Date.now()) => bangkokDate(Date.parse(`${bangkokDate(now)}T12:00:00+07:00`) - DAY_MS);

export function isKpiDate(v: string | null | undefined): v is string {
  if (!v || !DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T12:00:00+07:00`);
  return Number.isFinite(t) && bangkokDate(t) === v;
}

/** ช่วงเวลาของวันนั้นตามเวลาไทย เป็น ISO UTC: from ≤ t < to */
export function bangkokDayRange(date: string) {
  const start = Date.parse(`${date}T00:00:00+07:00`);
  return { from: new Date(start).toISOString(), to: new Date(start + DAY_MS).toISOString() };
}

export interface KpiStaffMessage { conversation_id: string; sender_id: string | null }
export interface KpiResponseEvent { replied_by: string; response_seconds: number }
export interface KpiStaff { id: string; hr_employee_id: string | null }

export interface ChatKpiRecord {
  date: string;
  email?: string;
  employee_code?: string;
  chats: number;
  replies: number;
  avg_first_response_sec?: number;
}

/**
 * แยกรายเจ้าหน้าที่ เฉพาะคนที่มีการตอบในวันนั้น
 * - chats = จำนวนแชทที่ตอบ · replies = จำนวนข้อความที่ส่ง (ข้อความของ AI ไม่อยู่ในชุดนี้)
 * - avg_first_response_sec = เฉลี่ยเวลาจากข้อความลูกค้าที่ยังไม่มีคนตอบ ถึงคำตอบแรก (response_events) ไม่มีก็ไม่ส่งช่องนี้
 * - ตัวตน: จับคู่ HR ไว้และรู้รหัสพนักงาน ส่ง employee_code · ไม่งั้นส่งอีเมล · ไม่มีทั้งคู่ข้าม
 * ไม่มีระบบให้คะแนนจากลูกค้า จึงไม่ส่ง rating_avg
 */
export function buildChatKpiRecords(input: {
  date: string;
  messages: KpiStaffMessage[];
  responses: KpiResponseEvent[];
  staff: KpiStaff[];
  emails: Map<string, string | null | undefined>;
  hrCodes: Map<string, string | null | undefined>;
}): ChatKpiRecord[] {
  const stats = new Map<string, { chats: Set<string>; replies: number; seconds: number[] }>();
  const of = (id: string) => {
    let s = stats.get(id);
    if (!s) stats.set(id, (s = { chats: new Set(), replies: 0, seconds: [] }));
    return s;
  };
  for (const m of input.messages) {
    if (!m.sender_id) continue;
    const s = of(m.sender_id);
    s.replies++;
    s.chats.add(m.conversation_id);
  }
  for (const r of input.responses) {
    if (r.replied_by && Number.isFinite(r.response_seconds)) of(r.replied_by).seconds.push(Math.max(0, r.response_seconds));
  }

  const staff = new Map(input.staff.map((s) => [s.id, s]));
  const records: ChatKpiRecord[] = [];
  for (const [id, s] of stats) {
    const hrId = staff.get(id)?.hr_employee_id;
    const code = hrId ? input.hrCodes.get(hrId)?.trim() : undefined;
    const email = input.emails.get(id)?.trim().toLowerCase();
    if (!code && !email) continue;
    records.push({
      date: input.date,
      ...(code ? { employee_code: code } : { email }),
      chats: s.chats.size,
      replies: s.replies,
      ...(s.seconds.length ? { avg_first_response_sec: Math.round(s.seconds.reduce((a, b) => a + b, 0) / s.seconds.length) } : {}),
    });
  }
  return records.sort((a, b) => (a.employee_code ?? a.email ?? "").localeCompare(b.employee_code ?? b.email ?? ""));
}
