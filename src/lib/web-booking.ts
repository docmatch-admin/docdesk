/**
 * คำขอจองคิวจากหน้าเว็บคลินิก: ฟอร์มบนเว็บส่งเป็นข้อความ LINE รูปแบบ
 *   ต้องการจองคิว / โปรแกรม: ... / ราคา: ... / ชื่อ-นามสกุล: ... / เบอร์โทร: ... / วันที่สะดวก: 14/11/69 (/ เวลาที่สะดวก: ...)
 * AI ไม่ได้รับนัดจากข้อความนี้ (ไม่มีเวลา หรือปิด AI) จึงต้องให้เจ้าหน้าที่ยืนยันลงนัดเอง
 */
export interface WebBookingRequest {
  service: string;
  name: string | null;
  phone: string | null;
  /** YYYY-MM-DD (ค.ศ.) */
  date: string | null;
  /** HH:MM ถ้าลูกค้าระบุ */
  time: string | null;
}

const field = (text: string, labels: string[]) => {
  for (const label of labels) {
    const m = text.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*[:：]\\s*([^\\n]+)`));
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
};

/** 14/11/69 · 14/11/2569 · 14/11/2026 · 2026-11-14 → 2026-11-14 */
export function parseThaiDate(value: string | null): string | null {
  if (!value) return null;
  const iso = value.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = value.match(/(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  let y = Number(m[3]);
  if (y < 100) y += y >= 40 ? 2500 : 2000; // 69 → 2569 (พ.ศ.)
  if (y > 2400) y -= 543;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseWebBookingRequest(text: string | null | undefined): WebBookingRequest | null {
  if (!text || !/จองคิว|จองนัด|นัดหมาย/.test(text)) return null;
  const service = field(text, ["โปรแกรม", "บริการ", "แพ็กเกจ", "แพคเกจ"]);
  if (!service) return null;
  // "วัคซีนพิษสุนัขบ้า (วัคซีนพิษสุนัขบ้า)" → ตัดวงเล็บที่ซ้ำชื่อ
  const dup = service.match(/^(.+?)\s*\((.+)\)$/);
  const cleanService = dup && dup[1].trim() === dup[2].trim() ? dup[1].trim() : service;
  const phoneRaw = field(text, ["เบอร์โทร", "เบอร์โทรศัพท์", "เบอร์", "โทร"]);
  const digits = phoneRaw?.replace(/\D/g, "") ?? "";
  const timeRaw = field(text, ["เวลาที่สะดวก", "เวลา"]);
  const t = timeRaw?.match(/(\d{1,2})[:.](\d{2})/);
  return {
    service: cleanService.slice(0, 200),
    name: field(text, ["ชื่อ-นามสกุล", "ชื่อ - นามสกุล", "ชื่อนามสกุล", "ชื่อ"])?.slice(0, 200) ?? null,
    phone: digits.length >= 9 && digits.length <= 10 ? digits : null,
    date: parseThaiDate(field(text, ["วันที่สะดวก", "วันที่", "วันนัด"])),
    time: t && Number(t[1]) <= 23 && Number(t[2]) <= 59 ? `${t[1].padStart(2, "0")}:${t[2]}` : null,
  };
}
