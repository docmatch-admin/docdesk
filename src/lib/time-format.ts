/**
 * รูปแบบเวลาเดียวทั้งระบบ: "HH:mm" (เลขสองหลัก คั่นด้วย ":") ช่วงเวลา "08:00–12:00" (en dash ไม่มีเว้นวรรค)
 * ห้ามใช้ toLocaleString/Intl ด้วย locale th-TH แสดงเวลา เพราะได้ "08.00"
 * ใช้ได้ทั้ง server และหน้าเว็บ
 */
const two = (n: number) => String(Math.trunc(n)).padStart(2, "0");

/** formatTime(8, 0) → "08:00" */
export function formatTime(hh: number, mm: number): string {
  return `${two(hh)}:${two(mm)}`;
}

/** "8:00" / "08:00:00" / "08.00" → "08:00" (ค่าที่อ่านไม่ได้คืนตามเดิม) */
export function clock(time: string): string {
  const m = time.trim().match(/^(\d{1,2})[:.](\d{2})/);
  return m ? formatTime(Number(m[1]), Number(m[2])) : time;
}

/** "08:00:00", "12:00:00" → "08:00–12:00" */
export const timeRange = (start: string, end: string) => `${clock(start)}–${clock(end)}`;

const MONTH_TH_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** ส่วนวันเวลาตามเวลาไทย (ตัวเลขอารบิก) */
export function bangkokParts(input: string | number | Date) {
  const d = new Date(input);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

/** เวลาของ timestamp ตามเวลาไทย → "14:30" */
export const bangkokClock = (input: string | number | Date) => {
  const p = bangkokParts(input);
  return formatTime(p.hour, p.minute);
};

/** "9 พ.ย. 14:30" (withYear: "9 พ.ย. 69 14:30") ใช้แทน toLocaleString("th-TH", { hour, minute, ... }) */
export function thaiDateTime(input: string | number | Date, opts: { withYear?: boolean } = {}): string {
  const p = bangkokParts(input);
  const year = opts.withYear ? ` ${String(p.year + 543).slice(2)}` : "";
  return `${p.day} ${MONTH_TH_SHORT[p.month - 1]}${year} ${formatTime(p.hour, p.minute)}`;
}
