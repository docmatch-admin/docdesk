export interface BusinessHoursConfig {
  tz: string;
  days: Record<string, [string, string] | null>;
}

const MAX_DAYS = 400;

function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

export function offsetOf(ms: number, tz: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name === "GMT" ? "+00:00" : name.slice(3);
}

/**
 * วินาทีที่อยู่ในเวลาทำการระหว่าง from ถึง to
 * ลูกค้าทักนอกเวลา จึงเริ่มนับตอนเปิดทำการถัดไป
 * ถ้ายังไม่ได้ตั้งเวลาทำการเลย นับตามเวลาจริง ไม่อย่างนั้นทุกคำตอบจะกลายเป็น 0 วินาที
 */
export function businessSeconds(from: string | Date, to: string | Date, hours: BusinessHoursConfig): number {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!(end > start)) return 0;
  if (!Object.values(hours.days ?? {}).some(Boolean)) return Math.floor((end - start) / 1000);

  const tz = hours.tz || "Asia/Bangkok";
  const lastDate = localDate(end, tz);
  let date = localDate(start, tz);
  let total = 0;
  for (let i = 0; i < MAX_DAYS; i++) {
    const noon = Date.parse(`${date}T12:00:00Z`);
    const range = hours.days[String(new Date(noon).getUTCDay())];
    if (range) {
      const offset = offsetOf(noon, tz);
      const open = Date.parse(`${date}T${range[0]}:00${offset}`);
      const close = Date.parse(`${date}T${range[1]}:00${offset}`);
      total += Math.max(0, Math.min(end, close) - Math.max(start, open));
    }
    if (date === lastDate) break;
    date = new Date(noon + 86_400_000).toISOString().slice(0, 10);
  }
  return Math.floor(total / 1000);
}
