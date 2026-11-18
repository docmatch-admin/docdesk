// ผลแล็บจากแล็บนอก: ฟังก์ชันล้วน ไม่แตะฐานข้อมูล ใช้ได้ทั้ง server และหน้าเว็บ
import { OPEN_STATUSES, postbackData, thaiFullDate, type AppointmentStatus } from "./appointment-rules";
import { clock, timeRange } from "./time-format";

export const LAB_BUCKET = "lab-results";
/** ป้ายในไทม์ไลน์แชท (แสดงเป็น "⚙️ ส่งอัตโนมัติ · ผลแล็บ · …") */
export const LAB_SENDER_NAME = "ส่งอัตโนมัติ · ผลแล็บ";
/** คนไข้เปิดดู PDF ผ่าน signed URL อายุไม่เกิน 10 นาที */
export const LAB_SIGNED_URL_SECONDS = 600;
/** ห้ามเรียกระบบแล็บถี่กว่า 15 นาที (cron จริงชั่วโมงละครั้ง 13:00–18:00 น.) กันคนกดเรียก route ซ้ำ */
export const LAB_SYNC_MIN_INTERVAL_MS = 14 * 60_000;
/** ดูย้อนหลังกี่วันในแต่ละรอบ (หาผลใหม่ + version ที่แล็บแก้) */
export const LAB_SYNC_LOOKBACK_DAYS = 45;
export const LAB_SYNC_MAX_PAGES = 5;
/** ผลที่สั่งตรวจนานกว่านี้ ไม่แจ้งคนไข้อัตโนมัติ (กดส่งเองได้) */
export const LAB_AUTO_NOTIFY_MAX_AGE_DAYS = 30;
/** คนไข้รายแรกของระบบ: LN 26129150 (HN 4807, สั่งตรวจ 17 พ.ย. 69) — ตอนเริ่มระบบ ผลที่ LN น้อยกว่านี้นำเข้าเป็น "ผลเก่า (ไม่แจ้ง)" ตั้งแต่ LN นี้ขึ้นไปแจ้งตามปกติ */
export const LAB_NOTIFY_FROM_LN = 26129150;
export function labBeforeStart(ln: string | null | undefined): boolean {
  const n = Number(String(ln ?? "").replace(/\D/g, ""));
  return !n || n < LAB_NOTIFY_FROM_LN;
}
export const LAB_SYNC_STATE_KEY = "lab_sync_state";
export const LAB_TEAM_GROUP_KEY = "lab_team_line_group";

export type LabMatchStatus = "matched" | "unmatched" | "manual";
export type LabNotifyStatus = "pending" | "sent" | "unreachable" | "failed" | "skipped";

export interface LabResult {
  id: string;
  bml_id: string;
  ln: string | null;
  location_hn: string | null;
  hn_extraction_status: string | null;
  patient_id: string | null;
  patient_name: string | null;
  order_datetime: string | null;
  status: string | null;
  version_number: number;
  pdf_path: string | null;
  pdf_version: number | null;
  pdf_error: string | null;
  match_status: LabMatchStatus;
  notify_status: LabNotifyStatus;
  notified_at: string | null;
  notified_version: number | null;
  notify_error: string | null;
  team_notified_version: number | null;
  first_viewed_at: string | null;
  view_count: number;
  created_at: string;
}

export const LAB_COLUMNS = "id, bml_id, ln, location_hn, hn_extraction_status, patient_id, patient_name, order_datetime, status, version_number, pdf_path, pdf_version, pdf_error, match_status, notify_status, notified_at, notified_version, notify_error, team_notified_version, first_viewed_at, view_count, created_at";

export interface LabSyncState { last_run_at?: string | null; last_ok_at?: string | null; last_error?: string | null; initialized?: boolean }

/** ถึงเวลาเรียกระบบแล็บแล้วหรือยัง */
export function syncDue(state: LabSyncState | null | undefined, now = Date.now()): boolean {
  const last = Date.parse(state?.last_run_at ?? "");
  return !Number.isFinite(last) || now - last >= LAB_SYNC_MIN_INTERVAL_MS || last > now;
}

/** HN 9 หลักจาก location_hn (เฉพาะที่แล็บอ่านได้ ok) — อ่านไม่ได้/ว่าง/ไม่ใช่ตัวเลข = null ให้เจ้าหน้าที่จับคู่เอง */
export function labHn(locationHn: string | null | undefined, extraction: string | null | undefined): string | null {
  if (!/^(ok|success|succeeded|extracted|done)$/i.test((extraction ?? "").trim())) return null;
  const t = (locationHn ?? "").trim().replace(/^HN[\s:.-]*/i, "");
  return /^\d{1,9}$/.test(t) ? t.padStart(9, "0") : null;
}

/** ผลยังไม่สุดท้าย (รอผล/ยกเลิก) ไม่แจ้งคนไข้ */
export const isFinalLab = (status: string | null | undefined) => !/pend|process|wait|cancel|reject|draft/i.test(status ?? "");

export type SyncAction = "new" | "updated" | "same";
export function syncAction(existing: { version_number: number; pdf_path: string | null; pdf_version?: number | null } | null, version: number): SyncAction {
  if (!existing) return "new";
  if (version > existing.version_number) return "updated";
  // ไฟล์รอบก่อนโหลดไม่สำเร็จ: ลองโหลดใหม่ (ไม่นับเป็นการแก้ผล)
  return existing.pdf_path && (existing.pdf_version ?? existing.version_number) >= version ? "same" : "updated";
}

export const versionOf = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : 1);

/** ควรแจ้งคนไข้อัตโนมัติไหม (หลังโหลด PDF และจับคู่แล้ว) */
export function shouldAutoNotify(r: Pick<LabResult, "patient_id" | "pdf_path" | "status" | "order_datetime" | "notified_version" | "version_number" | "notify_status">, now = Date.now()): boolean {
  if (!r.patient_id || !r.pdf_path || !isFinalLab(r.status) || r.notify_status === "skipped") return false;
  if ((r.notified_version ?? 0) >= r.version_number) return false;
  const ordered = Date.parse(r.order_datetime ?? "");
  return !Number.isFinite(ordered) || now - ordered <= LAB_AUTO_NOTIFY_MAX_AGE_DAYS * 86_400_000;
}

/** รอบนี้แจ้งว่า "ผลมีการปรับปรุง" (เคยแจ้ง version ก่อนหน้าไปแล้ว) */
export const isUpdateNotice = (r: Pick<LabResult, "notified_version" | "version_number">) => (r.notified_version ?? 0) > 0 && (r.notified_version ?? 0) < r.version_number;

// ---------------------------------------------------------------------------
// นัดฟังผล
// ---------------------------------------------------------------------------
export interface LabAppointment {
  id: string; appoint_date: string; time_mode: string; time_start: string; time_end: string | null;
  status: AppointmentStatus; purpose_text: string | null; telemed_id?: string | null;
}
const HEARING = /ฟังผล|ผลแล็บ|ผลแลป|ผลเลือด|ผลตรวจ|lab\s*result|result/i;

/** นัดฟังผลที่ใกล้ที่สุดตั้งแต่วันนี้ (ยังไม่ปิด) */
export function resultHearingAppointment(appts: LabAppointment[], today: string): LabAppointment | null {
  return appts
    .filter((a) => OPEN_STATUSES.includes(a.status) && a.appoint_date >= today && HEARING.test(a.purpose_text ?? ""))
    .sort((a, b) => a.appoint_date.localeCompare(b.appoint_date) || a.time_start.localeCompare(b.time_start))[0] ?? null;
}

export const apptWhen = (a: Pick<LabAppointment, "appoint_date" | "time_mode" | "time_start" | "time_end">) =>
  `${thaiFullDate(a.appoint_date)} ${a.time_mode !== "exact" && a.time_end ? timeRange(a.time_start, a.time_end) : clock(a.time_start)} น.`;

// ---------------------------------------------------------------------------
// ข้อความ (ไม่มีค่าผลตรวจ มีแค่แจ้งว่าออกแล้ว + ปุ่มเปิดดู)
// ---------------------------------------------------------------------------
export function labViewUrl(liffId: string | null | undefined, appUrl: string, labId: string): string {
  return liffId ? `https://liff.line.me/${liffId}?id=${encodeURIComponent(labId)}` : `${appUrl.replace(/\/$/, "")}/lab-result?id=${encodeURIComponent(labId)}`;
}
/** หน้า "ผลแล็บของฉัน" (LIFF เดียวกัน ไม่มี id = แสดงรายการ) */
export function labMineUrl(liffId: string | null | undefined, appUrl: string): string {
  return liffId ? `https://liff.line.me/${liffId}?mine=1` : `${appUrl.replace(/\/$/, "")}/lab-result?mine=1`;
}

/** คนไข้พิมพ์ขอ/ถามผลแล็บในแชท (ไม่รวมถามราคาตรวจ) */
const LAB_REQUEST = [
  /(?:ขอ|ดู|เช็ค|เช็ก|ส่ง|รับ|อยากได้|อยากดู|อยากทราบ|ทราบ|ถาม)\s*(?:ใบ)?ผล\s*(?:แล็บ|แลบ|แล็ป|แลป|lab|เลือด|ตรวจ)/i,
  /ผล\s*(?:แล็บ|แลบ|แล็ป|แลป|lab|เลือด|ตรวจ).{0,20}(?:ออก|หรือยัง|รึยัง|ยัง|ได้|ไหม|มั้ย|ยังไง|อย่างไร|ที่ไหน|เมื่อไหร่|เมื่อไร|\?)/i,
  /\b(?:lab|test|blood)\s*results?\b/i,
];
export const isLabResultRequest = (text: string | null | undefined) => {
  const t = (text ?? "").trim();
  return !!t && t.length <= 300 && !/ราคา|กี่บาท|เท่าไหร่|เท่าไร|price|cost/i.test(t) && LAB_REQUEST.some((re) => re.test(t));
};
export const LAB_LINK_REPLY_TEXT = "ดูผลแล็บของคุณได้ที่ปุ่ม \"ผลแล็บของฉัน\" (เปิดได้เฉพาะบัญชี LINE ที่ผูกกับคลินิก) มีข้อสงสัยเกี่ยวกับผล สอบถามเจ้าหน้าที่ได้เลยค่ะ";

/** ปุ่มลิงก์ไปหน้า "ผลแล็บของฉัน" อย่างเดียว (AI ไม่อ่าน/ไม่สรุปผล) */
export function labLinkFlex(url: string) {
  return {
    type: "flex",
    altText: "ดูผลแล็บของฉัน",
    contents: {
      type: "bubble", size: "kilo",
      body: { type: "box", layout: "vertical", contents: [{ type: "text", text: LAB_LINK_REPLY_TEXT, size: "sm", wrap: true }] },
      footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#0f7a5f", height: "sm", action: { type: "uri", label: "ผลแล็บของฉัน", uri: url } }] },
    },
  };
}

export interface PatientNotice {
  clinic: string;
  patientName: string | null;
  /** บัญชีนี้ผูกหลาย HN: ระบุชื่อคนไข้ */
  showName: boolean;
  updated: boolean;
  orderDate: string | null;
  viewUrl: string;
  mineUrl: string;
  appointment: LabAppointment | null;
}

export function patientNoticeText(n: PatientNotice): string {
  const head = n.updated ? "ผลแล็บของคุณมีการปรับปรุง" : "ผลแล็บของคุณออกแล้ว";
  return [
    `${head}${n.showName && n.patientName ? ` (${n.patientName})` : ""}`,
    n.updated ? "แล็บแก้ไขผลตรวจ กรุณาดูฉบับล่าสุด" : "กดลิงก์เพื่อดูผล (ลิงก์ใช้ได้เฉพาะบัญชี LINE นี้)",
    ...(n.appointment ? [`นัดฟังผล: ${apptWhen(n.appointment)}`] : []),
    n.viewUrl,
    `ดูผลแล็บทั้งหมดของฉัน: ${n.mineUrl}`,
    n.clinic,
  ].join("\n");
}

export function patientNoticeFlex(n: PatientNotice) {
  const head = n.updated ? "ผลแล็บของคุณมีการปรับปรุง" : "ผลแล็บของคุณออกแล้ว";
  const a = n.appointment;
  const body: Record<string, unknown>[] = [
    { type: "text", text: head, weight: "bold", size: "md", wrap: true, color: n.updated ? "#8a5200" : "#0f7a5f" },
    ...(n.showName && n.patientName ? [{ type: "text", text: n.patientName, size: "sm", weight: "bold", wrap: true }] : []),
    { type: "text", text: n.updated ? "แล็บแก้ไขผลตรวจ กรุณากดดูฉบับล่าสุด" : "กดปุ่ม \"ดูผล\" เพื่อเปิดผลตรวจ (เปิดได้เฉพาะบัญชี LINE นี้)", size: "xs", color: "#6b7280", wrap: true },
    ...(a ? [
      { type: "separator", margin: "md" },
      { type: "text", text: "นัดฟังผล", size: "xs", color: "#6b7280", margin: "md" },
      { type: "text", text: apptWhen(a), size: "sm", weight: "bold", color: "#4a63e0", wrap: true },
    ] : []),
    { type: "text", text: n.clinic, size: "xxs", color: "#8a8f9c", wrap: true, margin: "md" },
  ];
  const buttons: Record<string, unknown>[] = [
    { type: "button", style: "primary", color: "#0f7a5f", height: "sm", action: { type: "uri", label: "ดูผล", uri: n.viewUrl } },
    { type: "button", style: "link", height: "sm", action: { type: "uri", label: "ดูผลแล็บทั้งหมดของฉัน", uri: n.mineUrl } },
  ];
  // ปุ่มยืนยัน/เลื่อนนัด ใช้ postback เดิมของระบบนัด (นัดที่มี telemed_id = นัดออนไลน์ เลื่อนเองไม่ได้ จึงมีแค่ยืนยัน)
  if (a) {
    buttons.push({
      type: "box", layout: "horizontal", spacing: "sm",
      contents: [
        { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "ยืนยันนัด", data: postbackData("confirm", a.id), displayText: "ยืนยันนัด" } },
        ...(a.telemed_id ? [] : [{ type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "ขอเลื่อนนัด", data: postbackData("reschedule", a.id), displayText: "ขอเลื่อนนัด" } }]),
      ],
    });
  }
  return {
    type: "flex",
    altText: `${head}${a ? ` · นัดฟังผล ${apptWhen(a)}` : ""}`.slice(0, 400),
    contents: {
      type: "bubble", size: "kilo",
      body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: buttons },
    },
  };
}

/** แจ้งทีมในกลุ่ม LINE: ชื่อ, HN, ลิงก์ดูใน DocDesk (ไม่มีค่าผล) */
export function teamNoticeText(r: Pick<LabResult, "patient_name" | "patient_id" | "location_hn" | "ln" | "match_status" | "id">, opts: { updated: boolean; appUrl: string; reachable: boolean | null }): string {
  const hn = r.patient_id ? r.patient_id.replace(/^0+/, "") : r.location_hn?.trim() || null;
  return [
    opts.updated ? "🔄 ผลแล็บปรับปรุง (แล็บแก้ผล)" : "🧪 ผลแล็บใหม่",
    `ชื่อ: ${r.patient_name?.trim() || "-"}`,
    `HN: ${hn ?? "-"}${r.match_status === "unmatched" ? " (ยังไม่ได้จับคู่คนไข้)" : ""}`,
    ...(r.ln ? [`LN: ${r.ln}`] : []),
    ...(opts.reachable === false ? ["คนไข้ไม่ได้ผูก LINE (ไม่ได้ส่งแจ้งคนไข้)"] : []),
    `ดูผล: ${opts.appUrl.replace(/\/$/, "")}/lab-results?id=${r.id}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// หน้ารายการ
// ---------------------------------------------------------------------------
export type LabTab = "all" | "unmatched" | "failed" | "nolink" | "unviewed";
export const LAB_TABS: { key: LabTab; label: string }[] = [
  { key: "all", label: "ทั้งหมด" },
  { key: "unmatched", label: "รอจับคู่" },
  { key: "unviewed", label: "ยังไม่เปิดดู" },
  { key: "nolink", label: "ไม่ได้ผูก LINE" },
  { key: "failed", label: "ส่งไม่สำเร็จ" },
];
export const parseLabTab = (v: string | null | undefined): LabTab => (LAB_TABS.some((t) => t.key === v) ? (v as LabTab) : "all");

export function inLabTab(r: LabResult, tab: LabTab): boolean {
  if (tab === "unmatched") return r.match_status === "unmatched";
  if (tab === "failed") return r.notify_status === "failed";
  if (tab === "nolink") return r.notify_status === "unreachable";
  if (tab === "unviewed") return r.notify_status === "sent" && !r.first_viewed_at;
  return true;
}

export const NOTIFY_LABEL: Record<LabNotifyStatus, string> = {
  pending: "รอแจ้ง", sent: "แจ้งแล้ว", unreachable: "ไม่ได้ผูก LINE", failed: "ส่งไม่สำเร็จ", skipped: "ผลเก่า (ไม่แจ้ง)",
};
export const MATCH_LABEL: Record<LabMatchStatus, string> = { matched: "จับคู่อัตโนมัติ", unmatched: "รอจับคู่", manual: "จับคู่เอง" };

/** วันที่ตามเวลาไทย → ช่วงเวลา UTC สำหรับกรอง order_datetime (from ≤ t < to+1 วัน) */
export function bangkokDateRange(from: string | null | undefined, to: string | null | undefined): { gte?: string; lt?: string } {
  const ok = (d: string | null | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00+07:00`));
  return {
    ...(ok(from) ? { gte: new Date(Date.parse(`${from}T00:00:00+07:00`)).toISOString() } : {}),
    ...(ok(to) ? { lt: new Date(Date.parse(`${to}T00:00:00+07:00`) + 86_400_000).toISOString() } : {}),
  };
}

export interface LabSummary { today: number; unmatched: number; unviewed: number }
/** การ์ดสรุป: ผลใหม่วันนี้ (เข้า DocDesk วันนี้ ไม่นับผลเก่าตอนเริ่มระบบ) · รอจับคู่ · แจ้งแล้วคนไข้ยังไม่เปิดดู */
export function labSummary(rows: Pick<LabResult, "created_at" | "notify_status" | "match_status" | "first_viewed_at">[], todayStartIso: string): LabSummary {
  const start = Date.parse(todayStartIso);
  return {
    today: rows.filter((r) => Date.parse(r.created_at) >= start && r.notify_status !== "skipped").length,
    unmatched: rows.filter((r) => r.match_status === "unmatched").length,
    unviewed: rows.filter((r) => r.notify_status === "sent" && !r.first_viewed_at).length,
  };
}
