/**
 * สีชิปแท็ก: โหมดสว่างใช้พื้นการ์ด ขอบ+จุดเป็นสีแท็ก ตัวอักษรสีปกติ
 * โหมดมืดคำนวณจากสีแท็ก: พื้นเข้ม (สีแท็กผสมพื้นการ์ดมืด) ตัวอักษรสว่าง (สีแท็กผสมขาว จนคอนทราสต์ ≥ 4.5:1)
 * อ่านได้ทุกสี รวมเหลืองอ่อนและม่วงสด
 */
const DARK_CARD = "#1a1e28";

const rgb = (hex: string): [number, number, number] => {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) h = "475569";
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const hex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
/** t = สัดส่วนของ a (0–1) */
export const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v * t + y[i] * (1 - t))); };

function luminance(c: string) {
  const [r, g, b] = rgb(c).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** คอนทราสต์ตาม WCAG */
export function contrast(a: string, b: string) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export interface TagChipColors { color: string; darkBg: string; darkInk: string; darkBorder: string }

export function tagChipColors(color: string): TagChipColors {
  const c = hex(rgb(color));
  // สีอ่อนมาก (เหลืองอ่อน) ผสมน้อยลง พื้นชิปยังเข้มพอ
  const darkBg = mix(c, DARK_CARD, luminance(c) > 0.7 ? 0.16 : 0.24);
  // เริ่มจากสีแท็กผสมขาวครึ่งหนึ่ง ถ้ายังอ่านยากเพิ่มขาวทีละน้อย
  let w = 0.5;
  let darkInk = mix("#ffffff", c, w);
  while (contrast(darkInk, darkBg) < 4.5 && w < 1) { w = Math.min(1, w + 0.05); darkInk = mix("#ffffff", c, w); }
  return { color: c, darkBg, darkInk, darkBorder: mix(c, DARK_CARD, 0.65) };
}

/** style ของชิป: ตัวแปร CSS ที่ globals.css ใช้ (สว่าง = ขอบ/จุด · มืด = พื้น/ตัวอักษร/ขอบ) */
export function tagChipStyle(color: string): Record<string, string> {
  const t = tagChipColors(color);
  return { "--tag": t.color, "--tag-dark-bg": t.darkBg, "--tag-dark-ink": t.darkInk, "--tag-dark-border": t.darkBorder };
}
