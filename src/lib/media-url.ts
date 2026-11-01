import crypto from "node:crypto";

/** LINE อาจดึงรูปตอนลูกค้าเปิดแชท ไม่ใช่ตอนส่ง จึงต้องใช้ได้นาน */
export const OUT_URL_TTL_SECONDS = 30 * 24 * 60 * 60;

export type MediaVariant = "main" | "preview";

function hmac(messageId: string, variant: MediaVariant, exp: number, secret: string) {
  return crypto.createHmac("sha256", secret).update(`${messageId}:${variant}:${exp}`).digest("hex");
}

/** URL สำหรับ LINE/Meta ดึงรูปขาออก: ไม่ต้องล็อกอิน ใช้ลายเซ็นแทน */
export function buildOutMediaUrl(
  origin: string,
  messageId: string,
  variant: MediaVariant,
  now = Date.now(),
  secret = process.env.MEDIA_URL_SECRET,
): string {
  if (!secret) throw new Error("ต้องตั้ง MEDIA_URL_SECRET");
  const exp = Math.floor(now / 1000) + OUT_URL_TTL_SECONDS;
  const sig = hmac(messageId, variant, exp, secret);
  return `${origin}/api/media/out/${messageId}?v=${variant}&exp=${exp}&sig=${sig}`;
}

export function verifyOutMediaSignature(
  messageId: string,
  params: { v: string | null; exp: string | null; sig: string | null },
  now = Date.now(),
  secret = process.env.MEDIA_URL_SECRET,
): boolean {
  const { v, exp, sig } = params;
  if (!secret || !sig || !exp || (v !== "main" && v !== "preview")) return false;
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 <= now) return false;
  const a = Buffer.from(hmac(messageId, v, Number(exp), secret));
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
