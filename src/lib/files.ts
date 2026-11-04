/**
 * ไฟล์เอกสารในแชท (ตอนนี้รับเฉพาะ PDF) ใช้ได้ทั้ง server และหน้าเว็บ จึงไม่ import อะไรที่เป็น server-only
 * รูปยังใช้ media.ts ตามเดิม
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_WEB_FILE_BYTES = 10 * 1024 * 1024;
/** LINE ส่งไฟล์ไม่ได้ ลูกค้าได้การ์ดพร้อมลิงก์ที่หมดอายุเอง เพราะไฟล์มักเป็นข้อมูลสุขภาพ */
export const FILE_LINK_DAYS = 7;

export type DocKind = "pdf";

/** ดูจากเนื้อไฟล์ ไม่เชื่อนามสกุล สเปก PDF ยอมให้มีข้อมูลก่อน %PDF- ได้ไม่เกิน 1KB */
export function detectDocType(buf: Uint8Array): DocKind | null {
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  const end = Math.min(buf.length, 1024) - sig.length;
  for (let i = 0; i <= end; i++) {
    if (sig.every((b, j) => buf[i + j] === b)) return "pdf";
  }
  return null;
}

export const isPdfName = (name: string | null | undefined) => /\.pdf$/i.test((name ?? "").trim());

/** ชื่อไฟล์ที่ปลอดภัยสำหรับแสดงและใส่ใน header: ตัด path อักขระควบคุม และอักขระต้องห้าม ลงท้าย .pdf เสมอ */
export function sanitizeFileName(name: string | null | undefined, fallback = "เอกสาร.pdf"): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").replace(/\s+/g, " ").trim();
  if (!clean || clean === ".pdf") return fallback;
  const withExt = isPdfName(clean) ? clean : `${clean}.pdf`;
  if (withExt.length <= 120) return withExt;
  return `${withExt.slice(0, 116)}.pdf`;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** ชื่อไฟล์จาก URL ของ Meta (ส่วนท้ายของ path) */
export function fileNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return sanitizeFileName(decodeURIComponent(last));
  } catch {
    return sanitizeFileName("");
  }
}
