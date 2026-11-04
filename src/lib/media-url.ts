import crypto from "node:crypto";

export const DEFAULT_RETENTION_DAYS = 90;

export type MediaVariant = "main" | "preview" | "file";

/** ค่าเสียหรือต่ำกว่า 1 วันต้องไม่ทำให้รูปถูกลบทั้งหมด หรือได้ลิงก์ที่หมดอายุทันที */
export function normalizeRetentionDays(value: unknown): number {
  const days = Number(value);
  return value !== null && Number.isFinite(days) && days >= 1 ? days : DEFAULT_RETENTION_DAYS;
}

function hmac(messageId: string, variant: MediaVariant, exp: number, secret: string) {
  return crypto.createHmac("sha256", secret).update(`${messageId}:${variant}:${exp}`).digest("hex");
}

/**
 * URL สำหรับ LINE/Meta ดึงรูปขาออก: ไม่ต้องล็อกอิน ใช้ลายเซ็นแทน
 * LINE อาจดึงรูปตอนลูกค้าเปิดแชท จึงให้ลิงก์อยู่นานเท่ากับที่เก็บรูป
 */
export function buildOutMediaUrl(
  origin: string,
  messageId: string,
  variant: MediaVariant,
  { ttlDays = DEFAULT_RETENTION_DAYS, now = Date.now(), secret = process.env.MEDIA_URL_SECRET, fileName }: { ttlDays?: number; now?: number; secret?: string; fileName?: string } = {},
): string {
  if (!secret) throw new Error("ต้องตั้ง MEDIA_URL_SECRET");
  const exp = Math.floor(now / 1000) + Math.round(ttlDays * 24 * 60 * 60);
  const sig = hmac(messageId, variant, exp, secret);
  // ชื่อไฟล์ต่อท้าย path ให้ Messenger แสดงชื่อ ไม่เกี่ยวกับสิทธิ์
  const name = fileName ? `/${encodeURIComponent(fileName)}` : "";
  return `${origin}/api/media/out/${messageId}${name}?v=${variant}&exp=${exp}&sig=${sig}`;
}

export function verifyOutMediaSignature(
  messageId: string,
  params: { v: string | null; exp: string | null; sig: string | null },
  now = Date.now(),
  secret = process.env.MEDIA_URL_SECRET,
): boolean {
  const { v, exp, sig } = params;
  if (!secret || !sig || !exp || (v !== "main" && v !== "preview" && v !== "file")) return false;
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 <= now) return false;
  const a = Buffer.from(hmac(messageId, v, Number(exp), secret));
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
