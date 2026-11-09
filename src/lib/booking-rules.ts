import { clock } from "./time-format";
import { offsetOf, type BusinessHoursConfig } from "./business-hours";
import type { SuggestionOption } from "./types";

/** ตรวจการจองด้วยโค้ด AI แค่ดึงข้อมูลจากแชท ไม่ได้ตัดสินว่ารับนัดได้ไหม ใช้ได้ทั้ง server และหน้าเว็บ */
export const LAST_SLOT_BEFORE_CLOSE_MINUTES = 30;

export interface BookingTemplates {
  confirm: string;
  ask_datetime: string;
  ask_service: string;
  offer_closed: string;
  offer_past: string;
  unavailable: string;
  staff_reschedule: string;
}

export const DEFAULT_BOOKING_TEMPLATES: BookingTemplates = {
  confirm: "ได้เลยค่ะ จอง{บริการ}ให้วัน{วัน}ที่ {วันที่} เวลา {เวลา} น. นะคะ 😊 มาถึงแจ้งชื่อที่เคาน์เตอร์ได้เลยค่ะ",
  ask_datetime: "ได้เลยค่ะ สะดวกมาวันไหน เวลากี่โมงดีคะ",
  ask_service: "ได้เลยค่ะ สนใจจองบริการอะไรดีคะ",
  offer_closed: "เวลานั้นคลินิกปิดทำการค่ะ สะดวกเป็น{ตัวเลือก}ไหมคะ",
  offer_past: "เวลานั้นผ่านไปแล้วค่ะ สะดวกเป็น{ตัวเลือก}ไหมคะ",
  unavailable: "ขออภัยค่ะ ตอนนี้คลินิกยังไม่มีบริการ {บริการ} จึงยังรับจองไม่ได้ค่ะ",
  staff_reschedule: "ขออภัยค่ะ นัด{บริการ}วัน{วัน}ที่ {วันที่} เวลา {เวลา} น. ต้องขอเลื่อนค่ะ สะดวกเป็น{ตัวเลือก}ไหมคะ",
};

export const BOOKING_TEMPLATE_LABEL: Record<keyof BookingTemplates, string> = {
  confirm: "ยืนยันนัด ใช้ {บริการ} {วัน} {วันที่} {เวลา}",
  ask_datetime: "ถามวันเวลา",
  ask_service: "ถามบริการ",
  offer_closed: "เวลาที่ขอคลินิกปิด ใช้ {ตัวเลือก}",
  offer_past: "เวลาผ่านไปแล้ว ใช้ {ตัวเลือก}",
  unavailable: "ไม่มีบริการ ใช้ {บริการ}",
  staff_reschedule: "เจ้าหน้าที่ขอเลื่อน ใช้ {บริการ} {วัน} {วันที่} {เวลา} {ตัวเลือก}",
};

export function normalizeBookingTemplates(value: unknown): BookingTemplates {
  const v = (value ?? {}) as Partial<Record<keyof BookingTemplates, unknown>>;
  const out = { ...DEFAULT_BOOKING_TEMPLATES };
  for (const key of Object.keys(out) as (keyof BookingTemplates)[]) {
    const text = v[key];
    if (typeof text === "string" && text.trim()) out[key] = text;
  }
  return out;
}

export const fillTemplate = (template: string, values: Record<string, string>) =>
  template.replace(/\{([^{}]+)\}/g, (all, key: string) => values[key] ?? all);

// ---------------------------------------------------------------------------
// วันเวลา
// ---------------------------------------------------------------------------
const WEEKDAY = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const MONTH = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

const noon = (date: string) => Date.parse(`${date}T12:00:00Z`);
const addDays = (date: string, days: number) => new Date(noon(date) + days * 86_400_000).toISOString().slice(0, 10);
const weekdayIndex = (date: string) => new Date(noon(date)).getUTCDay();
const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const fromMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export const thaiWeekday = (date: string) => WEEKDAY[weekdayIndex(date)];
export const thaiDate = (date: string) => `${Number(date.slice(8, 10))} ${MONTH[Number(date.slice(5, 7)) - 1]}`;
/** "08:00" (ตัวคั่น ":" ทั้งระบบ) */
export const thaiTime = (time: string) => clock(time);
const slotText = (s: BookingSlot) => `วัน${thaiWeekday(s.date)}ที่ ${thaiDate(s.date)} เวลา ${thaiTime(s.time)} น.`;

export const localToday = (now: number, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));

/** รับ พ.ศ. ด้วย AI อาจตอบตามปีไทย คืน null ถ้าไม่ใช่วันที่จริง เช่น 31 กุมภาพันธ์ */
export function parseBookingDate(value: unknown): string | null {
  const m = typeof value === "string" ? value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!m) return null;
  const year = Number(m[1]) > 2400 ? Number(m[1]) - 543 : Number(m[1]);
  const date = `${year}-${m[2]}-${m[3]}`;
  return !Number.isNaN(noon(date)) && new Date(noon(date)).toISOString().slice(0, 10) === date ? date : null;
}

export function parseBookingTime(value: unknown): string | null {
  const m = typeof value === "string" ? value.trim().match(/^(\d{1,2})[:.](\d{2})/) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

const WEEKDAY_WORDS: [RegExp, number][] = [
  [/จันทร์/, 1], [/อังคาร/, 2], [/พุธ/, 3], [/พฤหัส/, 4], [/ศุกร์/, 5], [/เสาร์/, 6],
  // "อาทิตย์หน้า" แปลว่าสัปดาห์หน้าได้ จึงนับเฉพาะที่ชัดว่าเป็นวัน
  [/วันอาทิตย์|อาทิตย์(นี้|เช้า|บ่าย|เย็น|\s*\d)/, 0],
];

/**
 * วันที่ที่ลูกค้าพูดชัดเจนคำนวณด้วยโค้ด AI อ่าน "พรุ่งนี้" ผิดเป็นวันอื่นได้ และคำยืนยันถูกส่งเอง
 * วันที่ที่ระบุเลขหรือคำอื่นใช้ค่าจาก AI แล้วให้ decideBooking ตรวจต่อ
 */
export function resolveBookingDate(text: string, aiDate: unknown, today: string): unknown {
  if (/มะรืน/.test(text)) return addDays(today, 2);
  if (/พรุ่งนี้|tomorrow/i.test(text)) return addDays(today, 1);
  if (/เมื่อวาน|yesterday/i.test(text)) return addDays(today, -1);
  if (/วันนี้|today/i.test(text)) return today;
  if (/\d{1,2}\s*(ม\.?ค|ก\.?พ|มี\.?ค|เม\.?ย|พ\.?ค|มิ\.?ย|ก\.?ค|ส\.?ค|ก\.?ย|ต\.?ค|พ\.?ย|ธ\.?ค)/.test(text) || /\d{1,2}\/\d{1,2}/.test(text)) return aiDate;
  const named = WEEKDAY_WORDS.find(([word]) => word.test(text));
  if (!named) return aiDate;
  const parsed = parseBookingDate(aiDate);
  if (parsed && parsed >= today && weekdayIndex(parsed) === named[1]) return parsed;
  const days = (named[1] - weekdayIndex(today) + 7) % 7;
  return addDays(today, days);
}

/** เวลาที่พูดเป็นภาษาไทยคำนวณด้วยโค้ด ไม่พบก็ใช้ค่าจาก AI ต้องส่งข้อความที่ลบเบอร์แล้ว */
export function resolveBookingTime(text: string, aiTime: unknown): unknown {
  const half = /ครึ่ง/.test(text) ? "30" : "00";
  const at = (hour: number, minute = half) => `${String(hour).padStart(2, "0")}:${minute}`;
  const exact = text.match(/(?<![\d/])(\d{1,2})[:.](\d{2})(?!\d)/);
  if (exact && Number(exact[1]) <= 23 && Number(exact[2]) <= 59) return at(Number(exact[1]), exact[2]);
  if (/บ่ายโมง/.test(text)) return at(13);
  let m = text.match(/บ่าย\s*(\d{1,2})/);
  if (m && Number(m[1]) <= 6) return at(12 + Number(m[1]));
  if (/เที่ยง/.test(text)) return at(12);
  m = text.match(/(\d{1,2})\s*ทุ่ม/);
  if (m && Number(m[1]) <= 5) return at(18 + Number(m[1]));
  m = text.match(/ตี\s*(\d{1,2})/);
  if (m && Number(m[1]) <= 5) return at(Number(m[1]));
  m = text.match(/(\d{1,2})\s*โมง(เช้า|เย็น)?/);
  if (m && Number(m[1]) <= 12) {
    const hour = Number(m[1]);
    if (m[2] === "เช้า") return at(hour);
    // "4 โมง" ที่ไม่ระบุ คลินิกหมายถึงช่วงเย็น ส่วน 7-12 โมงคือช่วงเช้า
    return at(m[2] === "เย็น" || hour <= 6 ? (hour === 12 ? 12 : hour + 12) : hour);
  }
  return aiTime;
}

const instantOf = (date: string, time: string, tz: string) => Date.parse(`${date}T${time}:00${offsetOf(noon(date), tz)}`);

/** ช่วงเวลาที่รับนัดได้ของวันนั้น เป็นนาทีนับจากเที่ยงคืน */
function bookableRange(date: string, hours: BusinessHoursConfig): [number, number] | null {
  const range = hours.days?.[String(weekdayIndex(date))];
  if (!range) return null;
  const last = toMinutes(range[1]) - LAST_SLOT_BEFORE_CLOSE_MINUTES;
  return last >= toMinutes(range[0]) ? [toMinutes(range[0]), last] : null;
}

export function isStillBookable(date: string, time: string, hours: BusinessHoursConfig, now: number): boolean {
  const range = bookableRange(date, hours);
  const minutes = toMinutes(time);
  return !!range && minutes >= range[0] && minutes <= range[1] && instantOf(date, time, hours.tz || "Asia/Bangkok") > now;
}

export interface BookingSlot { date: string; time: string }

/** เวลาเปิดที่ใกล้เวลาที่ขอที่สุด เริ่มจากวันที่ขอ แล้วไล่วันถัดไปด้วยเวลาเดิม */
export function nearestSlots(date: string, time: string, hours: BusinessHoursConfig, now: number, limit = 2): BookingSlot[] {
  const tz = hours.tz || "Asia/Bangkok";
  const today = localToday(now, tz);
  const start = date < today ? today : date;
  const wanted = toMinutes(time);
  const out: BookingSlot[] = [];
  for (let i = 0; i < 30 && out.length < limit; i++) {
    const day = addDays(start, i);
    const range = bookableRange(day, hours);
    if (!range) continue;
    let minutes = Math.min(Math.max(wanted, range[0]), range[1]);
    if (instantOf(day, fromMinutes(minutes), tz) <= now) {
      // เลยเวลาไปแล้วในวันนี้: ปัดขึ้นเป็นครึ่งชั่วโมงถัดไป
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(now));
      minutes = Math.ceil((toMinutes(parts.replace(/^24/, "00")) + 1) / 30) * 30;
      if (minutes > range[1]) continue;
      minutes = Math.max(minutes, range[0]);
    }
    out.push({ date: day, time: fromMinutes(minutes) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// บริการ
// ---------------------------------------------------------------------------
export interface BookingCatalog {
  /** ชื่อบริการ แพ็กเกจ และรายการแล็บ */
  names: string[];
  /** รายละเอียดในฐานข้อมูล เช่น เหมาจ่ายครอบคลุมตรวจรักษา */
  contents: string[];
  /** เนื้อหาของรายการ "บริการที่ยังไม่มี" */
  unavailableText: string;
  /** ชื่อเต็มของบริการที่ปิดบนเว็บ แยกจากข้อความด้านบนเพราะจับทีละคำแล้ว "วัคซีน" จะตรงกับวัคซีนทุกตัว */
  hiddenServices?: string[];
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, "");
const MIN_MATCH = 3;

export function matchService(service: string, catalog: BookingCatalog): "known" | "unavailable" | "unknown" {
  const wanted = squash(service);
  if (!wanted) return "unknown";
  const names = catalog.names.map(squash).filter(Boolean);
  if (names.includes(wanted)) return "known";
  if ((catalog.hiddenServices ?? []).map(squash).includes(wanted)) return "unavailable";

  const unavailable = squash(catalog.unavailableText);
  const words = service.toLowerCase().split(/\s+/).filter((w) => w.length >= MIN_MATCH);
  if (unavailable && (unavailable.includes(wanted) || words.some((w) => unavailable.includes(w)))) return "unavailable";

  if (wanted.length < MIN_MATCH) return "unknown";
  const inName = names.some((n) => n.length >= MIN_MATCH && (n.includes(wanted) || wanted.includes(n)));
  return inName || catalog.contents.some((c) => squash(c).includes(wanted)) ? "known" : "unknown";
}

// ---------------------------------------------------------------------------
// ตัดสินการจอง
// ---------------------------------------------------------------------------
export interface BookingRequest { service?: unknown; date?: unknown; time?: unknown; name?: unknown; is_change?: unknown }
export interface ActiveBooking { service: string; date: string; time: string }

export type BookingAction = "confirm" | "ask_datetime" | "ask_service" | "offer_closed" | "offer_past" | "unavailable" | "unknown_service";

export interface BookingDecision {
  action: BookingAction;
  service: string | null;
  date: string | null;
  time: string | null;
  name: string | null;
  is_change: boolean;
  slots: BookingSlot[];
}

export function decideBooking(req: BookingRequest, ctx: {
  catalog: BookingCatalog;
  hours: BusinessHoursConfig;
  now: number;
  current?: ActiveBooking | null;
}): BookingDecision {
  const asked = typeof req.service === "string" ? req.service.trim() : "";
  const isChange = req.is_change === true;
  const service = asked || (isChange ? ctx.current?.service ?? "" : "");
  const date = parseBookingDate(req.date);
  const time = parseBookingTime(req.time);
  const base = {
    service: service || null, date, time,
    name: typeof req.name === "string" && req.name.trim() ? req.name.trim() : null,
    is_change: isChange, slots: [] as BookingSlot[],
  };

  if (!service) return { ...base, action: "ask_service" };
  const match = matchService(service, ctx.catalog);
  if (match === "unavailable") return { ...base, action: "unavailable" };
  if (match === "unknown") return { ...base, action: "unknown_service" };
  if (!date || !time) return { ...base, action: "ask_datetime" };
  if (isStillBookable(date, time, ctx.hours, ctx.now)) return { ...base, action: "confirm" };

  const passed = instantOf(date, time, ctx.hours.tz || "Asia/Bangkok") <= ctx.now;
  const slots = nearestSlots(date, time, ctx.hours, ctx.now);
  // ไม่ได้ตั้งเวลาทำการเลย จึงเสนอเวลาไม่ได้
  if (!slots.length) return { ...base, action: "ask_datetime" };
  return { ...base, action: passed ? "offer_past" : "offer_closed", slots };
}

export function bookingText(d: BookingDecision, t: BookingTemplates): string {
  const options = d.slots.map(slotText).join(" หรือ ");
  switch (d.action) {
    case "confirm":
      return fillTemplate(t.confirm, {
        บริการ: d.service ?? "", วัน: thaiWeekday(d.date as string), วันที่: thaiDate(d.date as string), เวลา: thaiTime(d.time as string),
      });
    case "ask_service": return t.ask_service;
    case "ask_datetime": return t.ask_datetime;
    case "offer_closed": return fillTemplate(t.offer_closed, { ตัวเลือก: options });
    case "offer_past": return fillTemplate(t.offer_past, { ตัวเลือก: options });
    default: return fillTemplate(t.unavailable, { บริการ: d.service ?? "" });
  }
}

/** ตัวเลือกแรกของคำแนะนำ ความมั่นใจมาจากการตรวจด้วยโค้ด ไม่ได้มาจาก AI */
export function bookingOption(d: BookingDecision, t: BookingTemplates): SuggestionOption {
  return {
    text: bookingText(d, t),
    source: "knowledge",
    ref_ids: [],
    confidence: 1,
    note: d.action === "confirm" ? "ระบบตรวจวันเวลาและบริการแล้ว"
      : d.action === "unknown_service" ? "ไม่พบบริการนี้ในฐานข้อมูล โปรดตรวจว่ามีจริงไหม"
      : undefined,
    booking: { action: d.action, service: d.service, date: d.date, time: d.time, name: d.name, is_change: d.is_change },
  };
}

/** ลูกค้าขอจองบริการที่ระบุว่ายังไม่มี คืนคำที่พบ AI อาจตอบว่าไม่ใช่การจองหรือส่งให้คน ทั้งที่ควรตอบได้เลย */
export function findUnavailableRequest(text: string, catalog: BookingCatalog): string | null {
  if (!/จอง|นัด|book|appointment/i.test(text)) return null;
  const hidden = (catalog.hiddenServices ?? []).find((name) => squash(text).includes(squash(name)));
  if (hidden) return hidden;
  const words = catalog.unavailableText.split(/\s+/).filter((w) => w.length >= MIN_MATCH && !/ยังไม่มี|^และ/.test(w));
  const hay = text.toLowerCase();
  return words.find((w) => hay.includes(w.toLowerCase())) ?? null;
}

/** เจ้าหน้าที่กดเลื่อน: เสนอวันถัดจากวันนัดเดิม */
export function rescheduleText(b: ActiveBooking, t: BookingTemplates, hours: BusinessHoursConfig, now: number): string {
  const slots = nearestSlots(addDays(b.date, 1), b.time.slice(0, 5), hours, now);
  return fillTemplate(t.staff_reschedule, {
    บริการ: b.service, วัน: thaiWeekday(b.date), วันที่: thaiDate(b.date), เวลา: thaiTime(b.time),
    ตัวเลือก: slots.map(slotText).join(" หรือ "),
  });
}

// ---------------------------------------------------------------------------
// ข้อความและข้อมูลส่วนตัว
// ---------------------------------------------------------------------------
const BOOKING_WORDS = ["จอง", "นัด", "ขอคิว", "เลื่อน", "เปลี่ยนเวลา", "เปลี่ยนวัน", "สะดวก", "book", "appointment", "reschedule"];

/** กันคำตอบติดดาวตอบแทนการจอง ซึ่งจะข้ามการตรวจวันเวลา */
export const hasBookingSignal = (text: string) => {
  const hay = text.toLowerCase();
  return BOOKING_WORDS.some((w) => hay.includes(w));
};

/** เบอร์ล่าสุดในข้อความลูกค้า ไม่รวมเบอร์คลินิก */
export function extractPhone(texts: string[]): string | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const hits = texts[i].match(/(?<!\d)0\d{1,2}[\s-]?\d{3}[\s-]?\d{3,4}(?!\d)/g) ?? [];
    const phone = hits.map((h) => h.replace(/[\s-]/g, "")).filter((h) => h !== "020004586" && h !== "0886837899").at(-1);
    if (phone) return phone;
  }
  return null;
}

/** ลบชื่อและเบอร์ของนัดเดิมออกจากข้อความ ก่อนส่งให้ AI หรือเก็บเป็นตัวอย่างคำตอบ */
export function maskBookingPii(text: string, bookings: { name?: string | null; phone?: string | null }[]): string {
  let out = text;
  for (const b of bookings) {
    if (b.name && b.name.trim().length >= 2) out = out.split(b.name.trim()).join("[ชื่อ]");
    if (b.phone) {
      const loose = b.phone.replace(/\D/g, "").split("").join("[\\s-]?");
      if (loose) out = out.replace(new RegExp(loose, "g"), "[เบอร์โทร]");
    }
  }
  return out;
}

/** ปฏิทินให้ AI แปลง "พรุ่งนี้" หรือ "เสาร์หน้า" เป็นวันที่ */
export function bookingCalendar(now: number, tz: string, days = 21): string {
  const today = localToday(now, tz);
  return Array.from({ length: days }, (_, i) => {
    const d = addDays(today, i);
    return `${d} วัน${thaiWeekday(d)}${i === 0 ? " (วันนี้)" : i === 1 ? " (พรุ่งนี้)" : ""}`;
  }).join("\n");
}
