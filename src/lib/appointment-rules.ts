import { clock, timeRange } from "./time-format";
import type { ChannelType } from "./types";

/**
 * ระบบนัดครั้งต่อไป: กติกาที่ไม่แตะฐานข้อมูล ใช้ได้ทั้ง server และหน้าเว็บ
 * ข้อความนัดสร้างจากเทมเพลตด้วยโค้ด ไม่ผ่าน AI และไม่ส่งข้อมูลนัดเข้า prompt
 */

export type TimeMode = "slot" | "exact";
export type AppointmentStatus = "scheduled" | "confirmed" | "reschedule_requested" | "cancelled" | "attended" | "no_show";
export const OPEN_STATUSES: AppointmentStatus[] = ["scheduled", "confirmed", "reschedule_requested"];

export interface Appointment {
  id: string;
  hn: string | null;
  patient_name: string;
  phone: string | null;
  conversation_id: string | null;
  booking_id?: string | null;
  name_from_his?: boolean;
  appoint_date: string;
  /** slot = มาได้ในช่วง (ตรวจตามลำดับคิว), exact = เวลาตรง */
  time_mode: TimeMode;
  slot_id: string | null;
  time_start: string;
  time_end: string | null;
  purpose_id: string | null;
  purpose_text: string | null;
  /** การปฏิบัติตัว ส่งในข้อความนัดเสมอ */
  instructions: string | null;
  provider: string | null;
  note: string | null;
  status: AppointmentStatus;
  link_code: string;
  confirm_sent_at: string | null;
  reminder_sent_at: string | null;
  reminder_attempted_at?: string | null;
  last_send_error: string | null;
  called_at: string | null;
  called_by: string | null;
  cancel_reason?: string | null;
  cancel_reason_code?: CancelReason | null;
  series_id?: string | null;
  series_seq?: number | null;
  series_label?: string | null;
  series_from?: SeriesFrom | null;
  series_offset_value?: number | null;
  series_offset_unit?: DateUnit | null;
  /** เข็มที่ฉีดแล้ว (ไม่ใช่นัด) */
  series_done?: boolean;
  cancelled_by?: string | null;
  cancelled_at?: string | null;
  created_at?: string;
}

/** เหตุผลยกเลิก: ลงนัดผิดไม่ส่งข้อความแจ้งคนไข้ */
export type CancelReason = "patient" | "doctor" | "mistake" | "other";
export const CANCEL_REASON_LABEL: Record<CancelReason, string> = {
  patient: "คนไข้ขอยกเลิก",
  doctor: "แพทย์ยกเลิก",
  mistake: "ลงนัดผิด",
  other: "อื่นๆ",
};
export const notifiesOnCancel = (reason: CancelReason) => reason !== "mistake";

/** กู้คืนนัดที่ยกเลิกได้ภายในวันเดียวกัน (เวลาไทย) */
export const canRestore = (a: { status: string; cancelled_at?: string | null }, now = Date.now()) =>
  a.status === "cancelled" && !!a.cancelled_at && bangkokToday(Date.parse(a.cancelled_at)) === bangkokToday(now);

/** แก้ไข/ยกเลิกได้เฉพาะนัดที่ยังเปิดอยู่ มาแล้ว/ไม่มา/ยกเลิก ดูได้อย่างเดียว */
export const isEditable = (a: { status: string }) => a.status === "scheduled" || a.status === "confirmed" || a.status === "reschedule_requested";

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: "นัดแล้ว",
  confirmed: "ยืนยันแล้ว",
  reschedule_requested: "ขอเลื่อน",
  cancelled: "ยกเลิก",
  attended: "มาตามนัด",
  no_show: "ไม่มาตามนัด",
};

// ---------------------------------------------------------------------------
// ตั้งค่า
// ---------------------------------------------------------------------------
export interface AppointmentSettings {
  reminder_time: string;
  send_purpose_in_message: boolean;
  /** ส่งข้อความนัดทันทีเมื่อลงนัด (LINE push) ปิด = ส่งแค่เตือนก่อนวันนัด ยกเว้นมี reply token */
  send_on_create: boolean;
  template_th: string;
  template_en: string;
  clinic_phone: string;
  /** เบอร์มือถือคลินิก (ว่าง = ไม่แสดง) */
  clinic_mobile: string;
  clinic_address: string;
  /** ใบนัด English */
  clinic_name_en: string;
  clinic_address_en: string;
  line_oa_id: string;
}

export const TEMPLATE_VARIABLES = ["{name}", "{date}", "{time}", "{clinic}", "{phone}", "{mobile}"];

export const DEFAULT_APPOINTMENT_SETTINGS: AppointmentSettings = {
  reminder_time: "10:00",
  send_purpose_in_message: false,
  send_on_create: true,
  template_th: "เรียน คุณ{name}\nนัดหมายครั้งต่อไปที่ {clinic}\n{date}\n{time}\nสอบถามโทร {phone}",
  template_en: "Dear {name},\nYour next appointment at {clinic}\n{date}\n{time}\nQuestions? Call {phone}",
  clinic_phone: "02-000-4586",
  clinic_mobile: "",
  clinic_address: "",
  clinic_name_en: "HappiWell Medical Clinic",
  clinic_address_en: "",
  line_oa_id: "@p49clinic",
};

export function normalizeAppointmentSettings(value: unknown): AppointmentSettings {
  const v = (value ?? {}) as Partial<Record<keyof AppointmentSettings, unknown>>;
  const text = (x: unknown, fallback: string, max = 2000) => (typeof x === "string" && x.trim() ? x.slice(0, max) : fallback);
  const time = typeof v.reminder_time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.reminder_time) ? v.reminder_time : DEFAULT_APPOINTMENT_SETTINGS.reminder_time;
  return {
    reminder_time: time,
    send_purpose_in_message: v.send_purpose_in_message === true,
    send_on_create: v.send_on_create !== false,
    template_th: text(v.template_th, DEFAULT_APPOINTMENT_SETTINGS.template_th),
    template_en: text(v.template_en, DEFAULT_APPOINTMENT_SETTINGS.template_en),
    clinic_phone: text(v.clinic_phone, DEFAULT_APPOINTMENT_SETTINGS.clinic_phone, 50),
    clinic_mobile: typeof v.clinic_mobile === "string" ? v.clinic_mobile.trim().slice(0, 50) : "",
    clinic_address: typeof v.clinic_address === "string" ? v.clinic_address.slice(0, 300) : "",
    clinic_name_en: text(v.clinic_name_en, DEFAULT_APPOINTMENT_SETTINGS.clinic_name_en, 120),
    clinic_address_en: typeof v.clinic_address_en === "string" ? v.clinic_address_en.slice(0, 300) : "",
    line_oa_id: text(v.line_oa_id, DEFAULT_APPOINTMENT_SETTINGS.line_oa_id, 50).trim(),
  };
}

// ---------------------------------------------------------------------------
// วันเวลา (เวลาไทย)
// ---------------------------------------------------------------------------
export const TZ = "Asia/Bangkok";
const WEEKDAY_TH = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const MONTH_TH = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const MONTH_TH_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const WEEKDAY_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const noon = (date: string) => Date.parse(`${date}T12:00:00Z`);
export const addDays = (date: string, days: number) => new Date(noon(date) + days * 86_400_000).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(noon(date)).getUTCDay();

/** วันเดียวกันของเดือนถัดไป ถ้าไม่มีวันนั้น (31 → 30) ใช้วันสุดท้ายของเดือน */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export const bangkokToday = (now = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));

export function bangkokClock(now = Date.now()): string {
  const s = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(now));
  return s.replace(/^24/, "00");
}

/** "วันจันทร์ที่ 16 พฤศจิกายน 2569" */
export const thaiFullDate = (date: string) =>
  `วัน${WEEKDAY_TH[weekday(date)]}ที่ ${Number(date.slice(8, 10))} ${MONTH_TH[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(0, 4)) + 543}`;
/** "จ. 16 พ.ย. 69" สำหรับตารางและปุ่ม */
export const thaiShortDate = (date: string) =>
  `${WEEKDAY_TH[weekday(date)]} ${Number(date.slice(8, 10))} ${MONTH_TH_SHORT[Number(date.slice(5, 7)) - 1]} ${String(Number(date.slice(0, 4)) + 543).slice(2)}`;
export const thaiMediumDate = (date: string) =>
  `${WEEKDAY_TH[weekday(date)]} ${Number(date.slice(8, 10))} ${MONTH_TH_SHORT[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(0, 4)) + 543}`;
export const englishDate = (date: string) =>
  `${WEEKDAY_EN[weekday(date)]}, ${Number(date.slice(8, 10))} ${MONTH_EN[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
/** "08:00" ตัวคั่น ":" ทั้งระบบ (ชื่อเดิมคงไว้ ใช้หลายที่) */
export const thaiClock = (time: string) => clock(time);

export function parseDate(value: unknown): string | null {
  const m = typeof value === "string" ? value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!m) return null;
  const year = Number(m[1]) > 2400 ? Number(m[1]) - 543 : Number(m[1]);
  const date = `${year}-${m[2]}-${m[3]}`;
  return !Number.isNaN(noon(date)) && new Date(noon(date)).toISOString().slice(0, 10) === date ? date : null;
}

export function parseTime(value: unknown): string | null {
  const m = typeof value === "string" ? value.trim().match(/^(\d{1,2})[:.](\d{2})/) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** ปุ่มลัดเลือกวันในฟอร์มนัด */
export function quickDates(today: string): { label: string; date: string }[] {
  return [
    { label: "+1 สัปดาห์", date: addDays(today, 7) },
    { label: "+2 สัปดาห์", date: addDays(today, 14) },
    { label: "+1 เดือน", date: addMonths(today, 1) },
    { label: "+3 เดือน", date: addMonths(today, 3) },
  ];
}

// ---------------------------------------------------------------------------
// นัดเป็นชุด (series)
// ---------------------------------------------------------------------------
export type SeriesFrom = "first" | "previous";
export const defaultSeriesLabel = (seq: number) => `เข็ม ${seq}`;

/** preset ที่มี default_days: หาร 30 ลงตัวใส่ช่องเดือน ไม่งั้นใส่ช่องวัน */
export const offsetFromDays = (days: number): { value: number; unit: DateUnit } =>
  days % 30 === 0 ? { value: days / 30, unit: "month" } : { value: days, unit: "day" };

/**
 * template ชุดเข็ม (รายการแรก = เข็ม 1 วันอ้างอิง offset 0) วันนี้ฉีดเข็ม N:
 * ข้ามเข็ม ≤ N เข็มที่เหลือ from=first นับจากวันฉีดเข็ม 1, from=previous เข็ม N+1 นับจากวันนี้ เข็มถัดไปนับจากเข็มก่อนหน้า
 */
export function planFromTemplate(
  items: { label: string; offset_value: number; offset_unit: DateUnit; from: SeriesFrom }[],
  doseToday: number, today: string, firstDoseDate: string | null,
): { dose: number; label: string; date: string; from: SeriesFrom; value: number; unit: DateUnit }[] {
  const firstBase = firstDoseDate || today;
  const out: { dose: number; label: string; date: string; from: SeriesFrom; value: number; unit: DateUnit }[] = [];
  items.forEach((it, i) => {
    const dose = i + 1;
    if (dose <= doseToday) return;
    const base = it.from === "first" ? firstBase : (out.at(-1)?.date ?? today);
    const date = relativeDate(base, it.offset_value, it.offset_unit) ?? base;
    out.push({ dose, label: it.label || defaultSeriesLabel(dose), date, from: it.from, value: it.offset_value, unit: it.offset_unit });
  });
  return out;
}

export interface SeriesItemRule { seq: number; date: string; from: SeriesFrom | null; value: number | null; unit: DateUnit | null }

/**
 * แก้วันของนัด seq = editedSeq แล้วนัดถัดไปที่นับจาก "นัดก่อนหน้า" เลื่อนตามเป็นทอดๆ
 * ถ้าแก้นัดแรก นัดที่นับจาก "นัดแรก" เลื่อนตามด้วย นัดที่ไม่ได้นับจากนัดที่เลื่อนคงเดิม
 */
export function shiftFollowing(items: SeriesItemRule[], editedSeq: number, newDate: string): { seq: number; date: string }[] {
  const sorted = [...items].sort((a, b) => a.seq - b.seq);
  const date = new Map(sorted.map((i) => [i.seq, i.date]));
  const moved = new Set<number>([editedSeq]);
  date.set(editedSeq, newDate);
  const out: { seq: number; date: string }[] = [];
  const first = sorted[0]?.seq;
  for (const i of sorted) {
    if (i.seq <= editedSeq || !i.from || i.value == null || !i.unit) continue;
    const anchor = i.from === "first" ? first : sorted[sorted.findIndex((x) => x.seq === i.seq) - 1]?.seq;
    if (anchor === undefined || !moved.has(anchor)) continue;
    const d = relativeDate(date.get(anchor) as string, i.value, i.unit);
    if (!d || d === i.date) continue;
    date.set(i.seq, d);
    moved.add(i.seq);
    out.push({ seq: i.seq, date: d });
  }
  return out;
}

/** ตัวเลข + หน่วย เช่น 10 วัน 6 สัปดาห์ นับจากวันนี้ */
export type DateUnit = "day" | "week" | "month";
export function relativeDate(today: string, amount: number, unit: DateUnit): string | null {
  const n = Math.floor(amount);
  if (!Number.isFinite(n) || n < 0 || n > 3650) return null;
  return unit === "month" ? addMonths(today, n) : addDays(today, unit === "week" ? n * 7 : n);
}

// ---------------------------------------------------------------------------
// เวลาเปิดคลินิก
// ---------------------------------------------------------------------------
export interface ClinicSlot { slot_id: string; label: string; start: string; end: string }
export interface ClinicSchedule {
  /** 0 = อาทิตย์ ไม่มีช่วง = ปิดทั้งวัน */
  hours: Record<number, ClinicSlot[]>;
  /** วันหยุดพิเศษ YYYY-MM-DD → เหตุผล */
  closures: Record<string, string>;
}

/** ค่าเริ่มต้นเหมือน seed ใน migration 039 */
export const DEFAULT_CLINIC_HOURS: ClinicSchedule["hours"] = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [
  { slot_id: "morning", label: "ช่วงเช้า", start: "08:00", end: "12:00" },
  ...(d >= 1 && d <= 5 ? [{ slot_id: "afternoon", label: "ช่วงบ่าย", start: "13:00", end: "18:00" }] : []),
]]));
export const DEFAULT_SLOT_ID = "morning";

export const weekdayOf = (date: string) => weekday(date);

/** ช่วงเวลาที่เปิดของวันนั้น วันหยุดพิเศษหรือวันปิดคืน [] */
export function slotsForDate(date: string, s: ClinicSchedule): ClinicSlot[] {
  if (s.closures[date] !== undefined) return [];
  return [...(s.hours[weekday(date)] ?? [])].sort((a, b) => a.start.localeCompare(b.start));
}

export const isClosedDate = (date: string, s: ClinicSchedule) => slotsForDate(date, s).length === 0;

/** วันเปิดถัดไปหลังวันนี้ (ไม่รวมวันที่ส่งมา) ภายใน 1 ปี */
export function nextOpenDate(date: string, s: ClinicSchedule): string | null {
  for (let i = 1; i <= 366; i++) {
    const d = addDays(date, i);
    if (!isClosedDate(d, s)) return d;
  }
  return null;
}

/** เวลาตรงอยู่ในช่วงเปิดไหม เวลาพักกลางวันระหว่างช่วงถือว่านอกเวลา */
export function isWithinOpenHours(date: string, time: string, s: ClinicSchedule): boolean {
  const t = time.slice(0, 5);
  return slotsForDate(date, s).some((slot) => t >= slot.start.slice(0, 5) && t < slot.end.slice(0, 5));
}

const range = (a: string, b: string, _th: boolean) => timeRange(a, b);

/** วลีเวลาในข้อความและใบนัด */
export function timePhrase(a: { time_mode: TimeMode; time_start: string; time_end: string | null }, lang: "th" | "en" = "th"): string {
  const th = lang === "th";
  if (a.time_mode === "slot" && a.time_end) {
    return th ? `เวลา ${range(a.time_start, a.time_end, true)} น. (ตรวจตามลำดับคิว)`
      : `Time ${range(a.time_start, a.time_end, false)} (Seen in queue order)`;
  }
  return th ? `เวลา ${thaiClock(a.time_start)} น.` : `Time ${clock(a.time_start)}`;
}

/** เวลาแบบสั้นในตาราง: "08:00–12:00" หรือ "09:30" */
export const timeShort = (a: { time_mode: TimeMode; time_start: string; time_end: string | null }) =>
  a.time_mode === "slot" && a.time_end ? range(a.time_start, a.time_end, true) : thaiClock(a.time_start);

export const DEFAULT_TIME_SLOTS = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00"];

/** เวลาที่ใช้บ่อยที่สุดก่อน แล้วเติมด้วยเวลามาตรฐานจนครบ เรียงตามเวลา */
export function commonTimes(used: string[], limit = 8): string[] {
  const count = new Map<string, number>();
  for (const t of used) {
    const p = parseTime(t);
    if (p) count.set(p, (count.get(p) ?? 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, limit);
  for (const t of DEFAULT_TIME_SLOTS) if (top.length < limit && !top.includes(t)) top.push(t);
  return top.sort();
}

/** เหตุผลนัดที่เคยพิมพ์ เรียงตามความถี่ ใช้เป็น autocomplete */
export function frequentTexts(values: (string | null)[], limit = 30): string[] {
  const count = new Map<string, number>();
  for (const v of values) {
    const t = v?.trim();
    if (t) count.set(t, (count.get(t) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, limit);
}

// ---------------------------------------------------------------------------
// รหัสผูกแชท
// ---------------------------------------------------------------------------
/** ไม่มี I O 0 1 เพราะอ่านผิดง่ายเมื่อพิมพ์จากใบนัด */
export const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateLinkCode(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  // 256 หาร 32 ลงตัว ทุกตัวอักษรจึงมีโอกาสเท่ากัน
  return [...random(6)].map((b) => LINK_CODE_ALPHABET[b % LINK_CODE_ALPHABET.length]).join("");
}

/**
 * "ยืนยันนัด #ABC234" จาก QR บนใบนัด หรือคนไข้พิมพ์เอง
 * รับ "text=" ข้างหน้าด้วย เผื่อแอปบางรุ่นเติม key ของลิงก์มาในข้อความ
 */
export function parseLinkCode(text: string): string | null {
  const t = text.trim().replace(/^text=/i, "");
  const m = t.match(/(?:ยืนยันนัด|ยืนยันการนัด|confirm(?:\s+appointment)?)\s*#\s*([A-Za-z0-9]{6})(?![A-Za-z0-9])/i)
    ?? t.match(/^#\s*([A-Za-z0-9]{6})$/);
  return m ? m[1].toUpperCase() : null;
}

/** QR บนใบนัด: เปิด LINE แล้วพิมพ์ข้อความรหัสให้ ลิงก์แบบ oaMessage ของ LINE ใส่ข้อความหลัง ? โดยตรง */
export function lineOaMessageUrl(lineOaId: string, linkCode: string): string {
  const id = lineOaId.trim().startsWith("@") ? lineOaId.trim() : `@${lineOaId.trim()}`;
  return `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(`ยืนยันนัด #${linkCode}`)}`;
}

// ---------------------------------------------------------------------------
// ปุ่มในข้อความ
// ---------------------------------------------------------------------------
export type PostbackAction = "confirm" | "reschedule";
export const TEST_APPOINTMENT_ID = "test";

export const postbackData = (action: PostbackAction, appointmentId: string) => `appt:${action}:${appointmentId}`;

export function parseAppointmentPostback(data: unknown): { action: PostbackAction; appointmentId: string } | null {
  const m = typeof data === "string" ? data.match(/^appt:(confirm|reschedule):([0-9a-f-]{36}|test)$/i) : null;
  return m ? { action: m[1].toLowerCase() as PostbackAction, appointmentId: m[2].toLowerCase() } : null;
}

// ---------------------------------------------------------------------------
// เลือกช่องทาง
// ---------------------------------------------------------------------------
export const META_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DeliveryFailure = "no_chat" | "outside_24h" | "web" | "archived" | "unsupported" | "unfollowed" | "quota";
export type Delivery = { ok: true; via: "line" | "facebook" | "instagram" } | { ok: false; reason: DeliveryFailure };

export const DELIVERY_FAILURE_TEXT: Record<DeliveryFailure, string> = {
  no_chat: "ยังไม่มีแชท — ให้คนไข้สแกน QR บนใบนัด",
  outside_24h: "ส่งไม่ได้-ต้องโทร: Facebook/Instagram ส่งได้เฉพาะภายใน 24 ชม. หลังคนไข้ทักล่าสุด",
  web: "ส่งไม่ได้-ต้องโทร: แชทหน้าเว็บส่งข้อความหาคนไข้ไม่ได้",
  archived: "ส่งไม่ได้-ต้องโทร: แชทนำเข้าจาก LINE OA ยังส่งข้อความไม่ได้",
  unsupported: "ส่งไม่ได้-ต้องโทร: ช่องทางนี้ยังไม่รองรับ",
  unfollowed: "ส่งไม่ได้-ต้องโทร: คนไข้เลิกติดตาม/บล็อก LINE OA",
  quota: "ส่งไม่ได้-ต้องโทร: โควตา LINE หมด",
};

/** ไม่ได้ส่งทันที (ไม่ใช่ความผิดพลาด ไม่เข้ารายการต้องโทร ยังมีเตือนก่อนวันนัด) */
export type DeliverySkip = "quota_low" | "send_on_create_off";
export const DELIVERY_SKIP_TEXT: Record<DeliverySkip, string> = {
  quota_low: "ยังไม่ส่ง: โควตา LINE เหลือน้อย เก็บไว้ส่งเตือนก่อนวันนัด",
  send_on_create_off: "ยังไม่ส่ง: ปิด \"ส่งข้อความทันทีเมื่อลงนัด\" จะส่งเตือนก่อนวันนัด",
};

/**
 * LINE ส่ง push ได้ทุกเวลา
 * Facebook/Instagram ส่งได้เฉพาะภายใน 24 ชม. หลังคนไข้ทักล่าสุด ข้อความนัดไม่ใช่การตอบของเจ้าหน้าที่ จึงห้ามใช้ message tag
 */
export function chooseDelivery(input: {
  channelType: ChannelType | null;
  lastInboundAt: string | Date | null;
  archived?: boolean;
  /** LINE: คนไข้เลิกติดตามหรือบล็อก OA */
  unfollowed?: boolean;
  now?: number;
}): Delivery {
  if (!input.channelType) return { ok: false, reason: "no_chat" };
  if (input.archived) return { ok: false, reason: "archived" };
  if (input.channelType === "line") return input.unfollowed ? { ok: false, reason: "unfollowed" } : { ok: true, via: "line" };
  if (input.channelType === "facebook" || input.channelType === "instagram") {
    const last = input.lastInboundAt ? new Date(input.lastInboundAt).getTime() : NaN;
    const age = (input.now ?? Date.now()) - last;
    return Number.isFinite(age) && age >= 0 && age <= META_WINDOW_MS
      ? { ok: true, via: input.channelType }
      : { ok: false, reason: "outside_24h" };
  }
  if (input.channelType === "web") return { ok: false, reason: "web" };
  return { ok: false, reason: "unsupported" };
}

// ---------------------------------------------------------------------------
// ข้อความ
// ---------------------------------------------------------------------------
export type MessageKind = "new" | "changed" | "reminder" | "cancelled" | "linked" | "test";
export type Lang = "th" | "en";

/** template_en เฉพาะแชทภาษาอังกฤษ ภาษาอื่นใช้ภาษาไทย */
export const pickLanguage = (contactLanguage: string | null | undefined): Lang => (contactLanguage === "en" ? "en" : "th");

const HEADER: Record<Lang, Record<MessageKind, string>> = {
  th: {
    new: "📅 นัดหมายครั้งต่อไป",
    changed: "🔄 เปลี่ยนวันนัดใหม่",
    reminder: "⏰ เตือนนัดพรุ่งนี้",
    cancelled: "❌ ยกเลิกนัด",
    linked: "✅ รับข้อความเตือนนัดทางแชทนี้แล้ว",
    test: "🧪 ทดสอบข้อความนัด",
  },
  en: {
    new: "📅 Your next appointment",
    changed: "🔄 Appointment rescheduled",
    reminder: "⏰ Appointment reminder: tomorrow",
    cancelled: "❌ Appointment cancelled",
    linked: "✅ You will get appointment reminders here",
    test: "🧪 Test appointment message",
  },
};

export const REPLY_TEXT: Record<Lang, { confirmed: string; reschedule: string; closed: string; notFound: string; test: string; alreadyLinked: string }> = {
  th: {
    confirmed: "ขอบคุณที่ยืนยันนัดค่ะ 🙏 แล้วพบกันนะคะ",
    reschedule: "รับเรื่องขอเลื่อนนัดแล้วค่ะ เจ้าหน้าที่จะติดต่อกลับเพื่อนัดวันใหม่ค่ะ",
    closed: "นัดนี้ถูกยกเลิกหรือผ่านไปแล้วค่ะ หากต้องการนัดใหม่ เจ้าหน้าที่จะช่วยดูให้ค่ะ",
    notFound: "ไม่พบรหัสนัดนี้ค่ะ รบกวนตรวจรหัสบนใบนัดอีกครั้ง หรือรอเจ้าหน้าที่ตอบกลับค่ะ",
    test: "ได้รับการกดปุ่มทดสอบแล้วค่ะ",
    alreadyLinked: "บัญชีนี้ผูกกับนัดนี้ไว้แล้วค่ะ จะได้รับข้อความเตือนก่อนวันนัดตามปกติ",
  },
  en: {
    confirmed: "Thank you for confirming your appointment 🙏 See you soon.",
    reschedule: "We received your reschedule request. Our staff will contact you to set a new date.",
    closed: "This appointment was cancelled or has passed. Our staff can help you book a new one.",
    notFound: "We could not find this appointment code. Please check the code on your card or wait for our staff.",
    test: "Test button received.",
    alreadyLinked: "This account is already linked to this appointment. You will get a reminder before the visit.",
  },
};

const BUTTON_LABEL: Record<Lang, Record<PostbackAction, string>> = {
  th: { confirm: "ยืนยันนัด", reschedule: "ขอเลื่อนนัด" },
  en: { confirm: "Confirm", reschedule: "Reschedule" },
};

export interface MessageInput {
  kind: MessageKind;
  lang: Lang;
  appointment: Pick<Appointment, "id" | "patient_name" | "appoint_date" | "time_mode" | "time_start" | "time_end" | "purpose_text" | "instructions">;
  settings: AppointmentSettings;
  clinicName: string;
  /** send_purpose_in_message และแชทไม่ใช่แชทลับ */
  includePurpose: boolean;
  /** เปลี่ยนนัด: วันเวลาเดิม */
  previous?: { appoint_date: string; time_mode: TimeMode; time_start: string; time_end: string | null };
  /** นัดเป็นชุด: ทุกนัดในชุด (การ์ดตอนลงนัด/เปลี่ยน/ยกเลิก) */
  series?: { label: string; appoint_date: string; time_mode: TimeMode; time_start: string; time_end: string | null; done?: boolean }[];
  /** เตือนนัดในชุด: เข็ม X จาก M */
  seriesPosition?: { label: string; seq: number; total: number };
  /** บัญชีที่ผูกหลาย HN: ระบุชื่อคนที่นัด ("นัดของ ...") */
  forPatient?: string;
}

const forPatientText = (input: MessageInput) =>
  input.forPatient?.trim() ? (input.lang === "en" ? `Appointment for ${input.forPatient.trim()}` : `นัดของ ${input.forPatient.trim()}`) : "";

function seriesLines(input: MessageInput): string[] {
  if (!input.series?.length) return [];
  return input.series.map((s) => {
    if (s.done) return input.lang === "en" ? `✓ ${s.label}: given ${englishDate(s.appoint_date)}` : `✓ ${s.label}: ฉีดแล้ว ${thaiMediumDate(s.appoint_date)}`;
    return input.lang === "en"
      ? `• ${s.label}: ${englishDate(s.appoint_date)} (${timeShort(s)})`
      : `• ${s.label}: ${thaiMediumDate(s.appoint_date)} (${timeShort(s)} น.)`;
  });
}

function positionText(input: MessageInput): string {
  const p = input.seriesPosition;
  if (!p) return "";
  const standard = p.label === defaultSeriesLabel(p.seq);
  if (input.lang === "en") return standard ? `Dose ${p.seq} of ${p.total}` : `${p.label} (${p.seq} of ${p.total})`;
  return standard ? `เข็ม ${p.seq} จาก ${p.total}` : `${p.label} (${p.seq} จาก ${p.total})`;
}

function previousText(input: MessageInput): string {
  const p = input.previous;
  if (!p || input.kind !== "changed") return "";
  return input.lang === "en"
    ? `Previously: ${englishDate(p.appoint_date)} (${timeShort(p)})`
    : `จากเดิม ${thaiFullDate(p.appoint_date)} (${timeShort(p)} น.)`;
}

/**
 * แทนตัวแปรใน template บรรทัดที่มี {mobile} แต่ไม่ได้ตั้งเบอร์มือถือ ตัดทั้งบรรทัด
 * ตั้งเบอร์มือถือแล้วแต่ template ไม่มี {mobile} ต่อท้ายบรรทัด "โทร/มือถือ ..." ให้เอง
 */
export function fillVariables(template: string, values: Record<string, string>): string {
  const mobile = values.mobile?.trim() ?? "";
  let t = template;
  if (!mobile) t = t.split("\n").filter((line) => !line.includes("{mobile}")).join("\n");
  else if (!t.includes("{mobile}")) t = `${t}\n${values.mobileLabel ?? "โทร/มือถือ"} {mobile}`;
  return t.replace(/\{(name|date|time|clinic|phone|mobile)\}/g, (all, key: string) => values[key] ?? all);
}

function variables(input: MessageInput): Record<string, string> {
  const a = input.appointment;
  return {
    name: a.patient_name,
    date: input.lang === "en" ? englishDate(a.appoint_date) : thaiFullDate(a.appoint_date),
    time: timePhrase(a, input.lang),
    clinic: input.clinicName,
    phone: input.settings.clinic_phone,
    mobile: input.settings.clinic_mobile ?? "",
    mobileLabel: input.lang === "en" ? "Mobile" : "โทร/มือถือ",
  };
}

export const hasButtons = (kind: MessageKind) => kind !== "cancelled";
const cancelledKind = (kind: MessageKind) => kind === "cancelled";

/** ข้อความเต็ม ใช้ส่ง Facebook/Instagram เป็น altText ของ LINE และบันทึกในแชท */
export function appointmentText(input: MessageInput): string {
  const v = variables(input);
  const forWho = forPatientText(input);
  const header = `${HEADER[input.lang][input.kind]}${forWho ? `\n${forWho}` : ""}`;
  if (input.kind === "cancelled") {
    const body = input.lang === "en"
      ? `Your appointment on ${v.date} (${timeShort(input.appointment)}) at ${v.clinic} has been cancelled.\nTo book again, call ${v.phone}${v.mobile ? ` / ${v.mobile}` : ""}`
      : `นัด${v.date} (${timeShort(input.appointment)} น.) ที่ ${v.clinic} ถูกยกเลิกแล้วค่ะ\nหากต้องการนัดใหม่ โทร ${v.phone}${v.mobile ? `\nโทร/มือถือ ${v.mobile}` : ""}`;
    const cancelledLines = seriesLines(input);
    const list = cancelledLines.length ? `\n${input.lang === "en" ? "Cancelled appointments:" : "นัดที่ยกเลิก:"}\n${cancelledLines.join("\n")}` : "";
    return `${header}\n${body}${list}`;
  }
  const purpose = input.includePurpose && input.appointment.purpose_text?.trim()
    ? `\n${input.lang === "en" ? "Purpose" : "เรื่อง"}: ${input.appointment.purpose_text.trim()}` : "";
  // การปฏิบัติตัวส่งเสมอ ไม่ขึ้นกับ send_purpose_in_message
  const instructions = input.appointment.instructions?.trim()
    ? `\n${input.lang === "en" ? "Before your visit" : "การปฏิบัติตัว"}: ${input.appointment.instructions.trim()}` : "";
  const previous = previousText(input);
  const position = positionText(input);
  const lines = seriesLines(input);
  const series = lines.length ? `\n${input.lang === "en" ? "Your appointments:" : "ตารางนัดทั้งชุด:"}\n${lines.join("\n")}` : "";
  return `${header}${position ? ` · ${position}` : ""}${previous ? `\n${previous}` : ""}\n${fillVariables(input.lang === "en" ? input.settings.template_en : input.settings.template_th, v)}${purpose}${instructions}${series}`;
}

type Json = Record<string, unknown>;

const row = (label: string, value: string, bold = false): Json => ({
  type: "box", layout: "baseline", spacing: "sm",
  contents: [
    { type: "text", text: label, size: "sm", color: "#8a8f9c", flex: 2 },
    { type: "text", text: value, size: "sm", wrap: true, flex: 5, ...(bold ? { weight: "bold" } : {}) },
  ],
});

/** LINE Flex: วันไทย พ.ศ. เวลา ชื่อคลินิก ที่อยู่ โทร และปุ่มยืนยัน/ขอเลื่อน */
export function appointmentFlex(input: MessageInput): Json {
  const v = variables(input);
  const th = input.lang === "th";
  const a = input.appointment;
  const purpose = input.includePurpose && a.purpose_text?.trim() ? a.purpose_text.trim() : null;
  const instructions = !cancelledKind(input.kind) && a.instructions?.trim() ? a.instructions.trim() : null;
  const cancelled = input.kind === "cancelled";
  const body: Json[] = [
    { type: "text", text: HEADER[input.lang][input.kind], weight: "bold", size: "md", color: cancelled ? "#c0392b" : "#1f2a44", wrap: true },
    ...(positionText(input) ? [{ type: "text", text: positionText(input), size: "sm", weight: "bold", color: "#4a63e0" }] : []),
    forPatientText(input)
      ? { type: "text", text: forPatientText(input), size: "sm", weight: "bold", color: "#1f2a44", wrap: true }
      : { type: "text", text: th ? `คุณ${a.patient_name}` : a.patient_name, size: "sm", color: "#555b66", wrap: true },
    { type: "separator", margin: "md" },
    {
      type: "box", layout: "vertical", margin: "md", spacing: "sm",
      contents: [
        ...(previousText(input) ? [row(th ? "เดิม" : "Was", previousText(input).replace(/^จากเดิม |^Previously: /, ""))] : []),
        row(th ? (input.previous ? "ใหม่" : "วันที่") : (input.previous ? "New" : "Date"), v.date, true),
        row(th ? "เวลา" : "Time", v.time, true),
        ...(purpose ? [row(th ? "เรื่อง" : "Purpose", purpose)] : []),
        ...(instructions ? [row(th ? "ปฏิบัติตัว" : "Before visit", instructions, true)] : []),
      ],
    },
    ...(seriesLines(input).length ? [
      { type: "separator", margin: "md" },
      {
        type: "box", layout: "vertical", margin: "md", spacing: "xs",
        contents: [
          { type: "text", text: th ? "ตารางนัดทั้งชุด" : "Your appointments", size: "sm", weight: "bold" },
          ...seriesLines(input).map((l) => ({ type: "text", text: l, size: "xs", wrap: true })),
        ],
      },
    ] : []),
    { type: "separator", margin: "md" },
    {
      type: "box", layout: "vertical", margin: "md", spacing: "xs",
      contents: [
        { type: "text", text: v.clinic, size: "sm", weight: "bold", wrap: true },
        ...(input.settings.clinic_address ? [{ type: "text", text: input.settings.clinic_address, size: "xs", color: "#8a8f9c", wrap: true }] : []),
        { type: "text", text: `${th ? "โทร" : "Tel"} ${v.phone}`, size: "xs", color: "#8a8f9c" },
        ...(v.mobile ? [{ type: "text", text: `${th ? "โทร/มือถือ" : "Mobile"} ${v.mobile}`, size: "xs", color: "#8a8f9c" }] : []),
      ],
    },
  ];
  const bubble: Json = { type: "bubble", size: "kilo", body: { type: "box", layout: "vertical", contents: body } };
  if (hasButtons(input.kind)) {
    const button = (action: PostbackAction, style: "primary" | "secondary"): Json => ({
      type: "button", style, height: "sm", ...(style === "primary" ? { color: "#4a63e0" } : {}),
      action: { type: "postback", label: BUTTON_LABEL[input.lang][action], data: postbackData(action, a.id), displayText: BUTTON_LABEL[input.lang][action] },
    });
    bubble.footer = { type: "box", layout: "horizontal", spacing: "sm", contents: [button("confirm", "primary"), button("reschedule", "secondary")] };
  }
  return { type: "flex", altText: appointmentText(input).slice(0, 400), contents: bubble };
}

/**
 * Facebook: button template (ข้อความไม่เกิน 640 ตัวอักษร)
 * Instagram ไม่รองรับ button template จึงใช้ quick reply ซึ่งได้ payload กลับมาเหมือนกัน
 */
export function metaAppointmentMessage(kind: "facebook" | "instagram", input: MessageInput): Json {
  const text = appointmentText(input);
  if (!hasButtons(input.kind)) return { text: [...text].slice(0, 1000).join("") };
  const id = input.appointment.id;
  const labels = BUTTON_LABEL[input.lang];
  if (kind === "facebook") {
    return {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: [...text].slice(0, 640).join(""),
          buttons: (["confirm", "reschedule"] as PostbackAction[]).map((a) => ({ type: "postback", title: labels[a], payload: postbackData(a, id) })),
        },
      },
    };
  }
  return {
    text: [...text].slice(0, 900).join(""),
    quick_replies: (["confirm", "reschedule"] as PostbackAction[]).map((a) => ({ content_type: "text", title: labels[a], payload: postbackData(a, id) })),
  };
}

// ---------------------------------------------------------------------------
// เตือนก่อนวันนัด
// ---------------------------------------------------------------------------
/**
 * send = ถึงเวลาเตือน, skip = คนไข้เพิ่งได้ข้อความนัดวันนี้ ไม่ต้องเตือนซ้ำ, null = ยังไม่ถึงหรือไม่ต้องเตือน
 * เตือนวันก่อนนัดเมื่อถึง reminder_time เฉพาะนัดที่ยังไม่ยืนยันเลื่อน และยังไม่เคยลองส่ง
 */
export function reminderDecision(a: Pick<Appointment, "status" | "appoint_date" | "reminder_sent_at" | "reminder_attempted_at" | "confirm_sent_at">,
  settings: Pick<AppointmentSettings, "reminder_time">, now = Date.now()): "send" | "skip" | null {
  if (a.status !== "scheduled" && a.status !== "confirmed") return null;
  if (a.reminder_sent_at || a.reminder_attempted_at) return null;
  const today = bangkokToday(now);
  if (a.appoint_date !== addDays(today, 1)) return null;
  if (bangkokClock(now) < settings.reminder_time) return null;
  if (a.confirm_sent_at && bangkokToday(Date.parse(a.confirm_sent_at)) === today) return "skip";
  return "send";
}

// ---------------------------------------------------------------------------
// สถานะในหน้านัดหมาย
// ---------------------------------------------------------------------------
export type DeliveryState = "reschedule" | "confirmed" | "failed" | "no_chat" | "sent" | "pending" | "closed";

export const DELIVERY_LABEL: Record<DeliveryState, string> = {
  reschedule: "ขอเลื่อน",
  confirmed: "ยืนยัน",
  failed: "ส่งไม่ได้-ต้องโทร",
  no_chat: "ไม่มีแชท-ต้องโทร",
  sent: "ส่งแล้ว",
  pending: "ยังไม่ส่ง",
  closed: "",
};

export function deliveryState(a: Pick<Appointment, "status" | "conversation_id" | "last_send_error" | "confirm_sent_at" | "reminder_sent_at">): DeliveryState {
  if (a.status === "reschedule_requested") return "reschedule";
  if (a.status === "confirmed") return "confirmed";
  if (a.status !== "scheduled") return "closed";
  if (!a.conversation_id) return "no_chat";
  if (a.last_send_error) return "failed";
  if (a.confirm_sent_at || a.reminder_sent_at) return "sent";
  return "pending";
}

/** ต้องโทร: นัดวันนี้หรือพรุ่งนี้ที่ส่งข้อความไม่ได้และยังไม่ได้โทร ขอเลื่อน: ทุกนัดที่ขอเลื่อนและยังไม่ได้โทร */
export function callQueue(rows: Pick<Appointment, "status" | "conversation_id" | "last_send_error" | "confirm_sent_at" | "reminder_sent_at" | "appoint_date" | "called_at">[], now = Date.now()) {
  const today = bangkokToday(now);
  const tomorrow = addDays(today, 1);
  let mustCall = 0, reschedule = 0;
  for (const a of rows) {
    if (a.called_at) continue;
    const state = deliveryState(a);
    if (state === "reschedule") reschedule++;
    else if ((state === "failed" || state === "no_chat") && a.appoint_date >= today && a.appoint_date <= tomorrow) mustCall++;
  }
  return { mustCall, reschedule, total: mustCall + reschedule };
}
