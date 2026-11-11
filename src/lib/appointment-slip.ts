import { englishDate, thaiFullDate, thaiMediumDate, thaiClock, type Appointment } from "./appointment-rules";

/**
 * ใบนัด thermal 80mm: ไทยหรืออังกฤษ ไม่ปนกันในใบเดียว
 * ใบอังกฤษ: ส่วนตายตัวเขียนไว้ในโค้ด ข้อความที่เจ้าหน้าที่พิมพ์ (เหตุผล การปฏิบัติตัว หมายเหตุ ชื่อชุดนัด)
 * มาจากการแปลตอนกด EN (en) ไม่มีคำแปลใช้ต้นฉบับไทย ชื่อคนไข้และชื่อหมอพิมพ์ตามที่กรอก ไม่แปล
 * ใช้ได้ทั้ง server และหน้าเว็บ (ไม่มี I/O)
 */
export type SlipField = "purpose" | "instructions" | "note" | "title";
export type SlipTexts = Partial<Record<SlipField, string>>;
export type SlipLang = "th" | "en";

export interface SlipClinic { name: string; nameEn: string; address: string; addressEn: string; phone: string; /** ว่าง = ไม่แสดง */ mobile?: string }

export interface SlipData {
  appointment: Appointment;
  /** นัดในชุด (ไม่รวมที่ยกเลิก) เรียงตามเข็ม */
  series: Appointment[];
  /** ชื่อชุดนัดที่ตั้งเอง (ไม่มีใช้ "ใบนัดวัคซีน") */
  seriesTitle?: string | null;
  clinic: SlipClinic;
  /** มีบัญชี LINE ที่ผูกและยังติดตามอยู่อย่างน้อย 1 บัญชี */
  linkedLine: boolean;
  issuedBy: string;
  issuedAt: string;
}

/** field = ข้อความที่แปลได้ (แก้คำแปลใน preview ได้) */
export interface SlipRow { label: string; value: string; field?: SlipField }
export interface SlipSeriesRow { label: string; when: string; done: boolean; current: boolean }

export interface SlipView {
  lang: SlipLang;
  clinicName: string;
  clinicAddress: string;
  clinicPhone: string;
  title: string;
  /** หัวใบเป็นชื่อชุดนัดที่ตั้งเอง (แปลได้) */
  titleEditable: boolean;
  name: SlipRow;
  hn: SlipRow | null;
  date: string;
  time: string;
  queueNote: string | null;
  rows: SlipRow[];
  series: SlipSeriesRow[] | null;
  seriesNote: string | null;
  qr: { sizeMm: 30 | 40; above: string[]; below: string[] };
  code: string;
  footer: string[];
}

const MONTH_EN_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const englishShortDate = (date: string) => `${Number(date.slice(8, 10))} ${MONTH_EN_SHORT[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
const WEEKDAY_EN_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const englishMediumDate = (date: string) => `${WEEKDAY_EN_SHORT[new Date(`${date}T12:00:00Z`).getUTCDay()]} ${englishShortDate(date)}`;

/** HN ของ iService เป็นตัวเลข 9 หลัก ใบนัดพิมพ์เต็ม (HN ที่ไม่ใช่ตัวเลขพิมพ์ตามเดิม) */
export const fullHn = (hn: string) => (/^\d{1,9}$/.test(hn.trim()) ? hn.trim().padStart(9, "0") : hn.trim());

type TimeFields = Pick<Appointment, "time_mode" | "time_start" | "time_end">;
const isSlot = (a: TimeFields) => a.time_mode === "slot" && !!a.time_end;
const clock = (t: string, lang: SlipLang) => (lang === "th" ? thaiClock(t) : t.slice(0, 5));
const range = (a: TimeFields, lang: SlipLang) => `${clock(a.time_start, lang)}–${clock(a.time_end ?? a.time_start, lang)}${lang === "th" ? " น." : ""}`;

/** แสดงแค่เวลา: "เวลา 08:00–12:00 น." / "Time 08:00–12:00" / "เวลา 14:30 น." / "Time 14:30" */
export function slipTime(a: TimeFields, lang: SlipLang): string {
  if (isSlot(a)) return `${lang === "th" ? "เวลา" : "Time"} ${range(a, lang)}`;
  return lang === "th" ? `เวลา ${thaiClock(a.time_start)} น.` : `Time ${a.time_start.slice(0, 5)}`;
}

/** "เข็ม 2" → "Dose 2" ป้ายที่ตั้งเองพิมพ์ตามเดิม */
export function doseLabel(label: string, lang: SlipLang): string {
  if (lang === "th") return label;
  const m = label.trim().match(/^เข็ม(?:ที่)?\s*(\d+)$/);
  return m ? `Dose ${m[1]}` : label;
}

const issuedTime = (iso: string, lang: SlipLang) => {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const hm = `${get("hour").replace(/^24/, "00")}:${get("minute")}`;
  if (lang === "en") return `${englishShortDate(date)} ${hm}`;
  const [, , short] = thaiMediumDate(date).split(" ");
  return `${Number(date.slice(8, 10))} ${short} ${Number(date.slice(0, 4)) + 543} ${hm} น.`;
};

/** ข้อความที่แปลได้ของนัดนี้ (ต้นฉบับไทย) ส่งไปแปลเฉพาะชุดนี้ */
export function slipSourceTexts(d: Pick<SlipData, "appointment" | "series" | "seriesTitle">): SlipTexts {
  const a = d.appointment;
  const out: SlipTexts = {};
  if (a.purpose_text?.trim()) out.purpose = a.purpose_text.trim();
  if (a.instructions?.trim()) out.instructions = a.instructions.trim();
  if (a.note?.trim()) out.note = a.note.trim();
  if (d.series.length > 1 && d.seriesTitle?.trim()) out.title = d.seriesTitle.trim();
  return out;
}

export function slipView(d: SlipData, lang: SlipLang, en: SlipTexts = {}): SlipView {
  const a = d.appointment;
  const th = lang === "th";
  const series = d.series.length > 1 ? d.series : null;
  const src = slipSourceTexts(d);
  const text = (f: SlipField) => (th ? src[f] : en[f]?.trim() || src[f]);
  const rows: SlipRow[] = [
    ...(a.provider ? [{ label: th ? "ผู้นัด" : "Doctor", value: a.provider }] : []),
    ...(src.purpose ? [{ label: th ? "เหตุผล" : "Purpose", value: text("purpose")!, field: "purpose" as const }] : []),
    ...(src.instructions ? [{ label: th ? "การปฏิบัติตัว" : "Instructions", value: text("instructions")!, field: "instructions" as const }] : []),
    ...(src.note ? [{ label: th ? "หมายเหตุ" : "Note", value: text("note")!, field: "note" as const }] : []),
  ];

  let seriesRows: SlipSeriesRow[] | null = null;
  let seriesNote: string | null = null;
  if (series) {
    seriesRows = series.map((x) => ({
      label: `${x.series_done ? "✓ " : ""}${doseLabel(x.series_label || "", lang)}`,
      when: x.series_done
        ? (th ? `ฉีดแล้ว ${thaiMediumDate(x.appoint_date)}` : `Given ${englishShortDate(x.appoint_date)}`)
        : `${th ? thaiMediumDate(x.appoint_date) : englishMediumDate(x.appoint_date)} · ${isSlot(x) ? range(x, lang) : clock(x.time_start, lang)}`,
      done: !!x.series_done,
      current: x.id === a.id,
    }));
    // เวลาอยู่ในตารางแต่ละแถวแล้ว ไม่ต้องมีบรรทัดสรุปช่วงเวลาใต้ตาราง
  }

  const linked = d.linkedLine;
  return {
    lang,
    clinicName: th ? d.clinic.name : d.clinic.nameEn || d.clinic.name,
    clinicAddress: th ? d.clinic.address : d.clinic.addressEn,
    // เบอร์คลินิกและเบอร์มือถือต่อกันหลังคำว่า "โทร" คำเดียว ไม่มีคำว่า "มือถือ" หน้าเบอร์
    clinicPhone: ((nums) => (nums.length ? `${th ? "โทร" : "Tel"} ${nums.join(" · ")}` : ""))(
      [d.clinic.phone?.trim(), d.clinic.mobile?.trim()].filter((n): n is string => !!n),
    ),
    title: series
      ? (src.title ? text("title")! : th ? "ใบนัดวัคซีน" : "Vaccination Appointment")
      : th ? "ใบนัด" : "Appointment",
    titleEditable: !!(series && src.title),
    name: { label: th ? "ชื่อ" : "Name", value: a.patient_name },
    hn: a.hn ? { label: "HN", value: fullHn(a.hn) } : null,
    date: th ? thaiFullDate(a.appoint_date) : englishDate(a.appoint_date),
    time: slipTime(a, lang),
    queueNote: isSlot(a) ? (th ? "(ตรวจตามลำดับคิว)" : "(Seen in queue order)") : null,
    rows,
    series: seriesRows,
    seriesNote,
    qr: linked
      ? {
        sizeMm: 30,
        above: th ? ["✓ ผูก LINE แล้ว", "ระบบจะแจ้งเตือนก่อนวันนัด 1 วัน"] : ["✓ LINE linked — reminders 1 day before"],
        below: th ? ["ญาติหรือเบอร์ใหม่", "สแกนเพื่อรับแจ้งเตือนเพิ่มได้"] : ["Family or a new phone can scan", "to also get reminders"],
      }
      : {
        sizeMm: 40,
        above: [],
        below: th ? ["สแกนแล้วกดส่ง", "เพื่อรับข้อความเตือนนัดทาง LINE"] : ["Scan & tap Send", "to get LINE reminders"],
      },
    code: `#${a.link_code}`,
    footer: th
      ? ["หากไม่สะดวกมาตามนัด กรุณาแจ้งล่วงหน้า", `ออกโดย ${d.issuedBy} · ${issuedTime(d.issuedAt, "th")}`]
      : ["Please let us know in advance if you can't make it.", `Issued by ${d.issuedBy} · ${issuedTime(d.issuedAt, "en")}`],
  };
}
