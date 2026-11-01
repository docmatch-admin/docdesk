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
  try {
    const res = await fetch(`${API}/message/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text: text.slice(0, 5000) }] }),
    });
    return res.ok;
  } catch (e) {
    console.error("LINE reply failed", e);
    return false;
  }
}

/** แจ้ง LINE ว่าอ่านแล้ว: ลูกค้าเห็น "อ่านแล้ว" ถึงข้อความของ token นี้และข้อความก่อนหน้าทั้งหมด */
export async function lineMarkAsRead(markAsReadToken: string) {
  const res = await fetch(`${API}/chat/markAsRead`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
    body: JSON.stringify({ markAsReadToken }),
  });
  if (!res.ok) throw new Error(`LINE markAsRead failed ${res.status}: ${await res.text()}`);
}

/** ใช้ replyToken ก่อนถ้ามี ถ้าไม่สำเร็จค่อย push */
export async function lineSend(userId: string, text: string, replyToken?: string) {
  if (replyToken && (await lineReply(replyToken, text))) return;
  return linePush(userId, text);
}
