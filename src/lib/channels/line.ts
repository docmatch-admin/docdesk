import crypto from "node:crypto";

const API = "https://api.line.me/v2/bot";
const token = () => process.env.LINE_CHANNEL_ACCESS_TOKEN!;

export function verifyLineSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function getLineProfile(userId: string): Promise<{ displayName?: string; pictureUrl?: string; language?: string }> {
  const res = await fetch(`${API}/profile/${userId}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (!res.ok) return {};
  return res.json();
}

/** ส่งข้อความหาลูกค้า (push) — ใช้ได้ทุกเวลา แต่นับโควต้าข้อความของ LINE OA */
export async function linePush(userId: string, text: string) {
  const res = await fetch(`${API}/message/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text: text.slice(0, 5000) }] }),
  });
  if (!res.ok) throw new Error(`LINE push failed ${res.status}: ${await res.text()}`);
}

/** ตอบกลับด้วย replyToken — ฟรี ไม่นับโควต้า แต่ token หมดอายุเร็ว (ใช้ตอน AI ตอบทันที) */
export async function lineReply(replyToken: string, text: string): Promise<boolean> {
  const res = await fetch(`${API}/message/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: text.slice(0, 5000) }] }),
  });
  return res.ok;
}
