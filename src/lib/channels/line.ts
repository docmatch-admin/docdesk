import crypto from "node:crypto";
import { logLineSend, type LineSendMeta } from "./line-log";

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


/** ที่อยู่สำหรับดาวน์โหลดรูปที่ลูกค้าส่งมา (ใช้ host คนละตัวกับ API อื่น) */
export function lineContentRequest(messageId: string) {
  return {
    url: `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    headers: { Authorization: `Bearer ${token()}` },
  };
}

export type LineMessage = Record<string, unknown>;

/** LINE รับได้สูงสุด 5 ข้อความต่อคำขอ (ทั้ง reply และ push) */
export const LINE_MAX_MESSAGES = 5;

const DEFAULT_META: LineSendMeta = { kind: "chat" };

/**
 * ส่งหลายข้อความ (บับเบิล) ในครั้งเดียว
 * - มี replyToken: ชุดแรก (สูงสุด 5) ส่งด้วย reply ซึ่งไม่นับโควตา ไม่สำเร็จ (หมดอายุ/ใช้แล้ว) push ชุดนั้นอัตโนมัติ
 * - token ใช้ได้ครั้งเดียว ข้อความเกิน 5 ชุดถัดไปจึงต้อง push
 * ทุกคำขอบันทึกใน line_sends ว่า reply หรือ push
 */
export async function lineSendMessages(userId: string, messages: LineMessage[], replyToken?: string, meta: LineSendMeta = DEFAULT_META) {
  const post = (path: string, body: Record<string, unknown>, chunk: LineMessage[]) => fetch(`${API}/message/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
    body: JSON.stringify({ ...body, messages: chunk }),
  });
  const base = { conversation_id: meta.conversationId ?? null, kind: meta.kind };
  for (let i = 0; i < messages.length; i += LINE_MAX_MESSAGES) {
    const chunk = messages.slice(i, i + LINE_MAX_MESSAGES);
    let fallback = false;
    if (i === 0 && replyToken) {
      let error: string | null = null;
      try {
        const res = await post("reply", { replyToken }, chunk);
        if (res.ok) {
          await logLineSend({ ...base, mode: "reply", message_count: chunk.length, ok: true, fallback: false, token_age_ms: meta.tokenAgeMs ?? null, error: null });
          continue;
        }
        error = `${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
      } catch (e) {
        console.error("LINE reply failed", e);
        error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      }
      await logLineSend({ ...base, mode: "reply", message_count: chunk.length, ok: false, fallback: false, token_age_ms: meta.tokenAgeMs ?? null, error });
      fallback = true;
    }
    const res = await post("push", { to: userId }, chunk);
    if (!res.ok) {
      const error = `LINE push failed ${res.status}: ${await res.text()}`;
      await logLineSend({ ...base, mode: "push", message_count: chunk.length, ok: false, fallback, token_age_ms: null, error: error.slice(0, 300) });
      throw new Error(error);
    }
    await logLineSend({ ...base, mode: "push", message_count: chunk.length, ok: true, fallback, token_age_ms: null, error: null });
  }
}

/** ส่งรูป: caption ไปเป็นข้อความถัดไปเพราะ image message ของ LINE ไม่มี caption */
export async function lineSendImage(
  userId: string,
  originalContentUrl: string,
  previewContentUrl: string,
  caption: string,
  replyToken?: string,
  meta: LineSendMeta = DEFAULT_META,
) {
  const messages: LineMessage[] = [{ type: "image", originalContentUrl, previewContentUrl }];
  if (caption.trim()) messages.push({ type: "text", text: caption.slice(0, 5000) });
  return lineSendMessages(userId, messages, replyToken, meta);
}

export interface LineFile { url: string; name: string; sizeText?: string; expiresAt: Date; language?: string }

/** LINE ไม่มีข้อความประเภทไฟล์ ส่งเป็นการ์ดชื่อไฟล์พร้อมปุ่มเปิด ลิงก์หมดอายุตาม expiresAt */
export function lineFileCard(f: LineFile): LineMessage {
  const th = !f.language || f.language === "th";
  const until = f.expiresAt.toLocaleDateString(th ? "th-TH" : "en-GB", {
    day: "numeric", month: "short", year: th ? "2-digit" : "numeric", timeZone: "Asia/Bangkok",
  });
  const meta = [f.sizeText, th ? `เปิดได้ถึง ${until}` : `Available until ${until}`].filter(Boolean).join(" · ");
  return {
    type: "flex",
    altText: `📄 ${f.name}`.slice(0, 400),
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box", layout: "vertical", spacing: "sm",
        contents: [
          { type: "text", text: th ? "📄 ไฟล์เอกสาร" : "📄 Document", size: "xs", color: "#8a8f9c" },
          { type: "text", text: f.name, weight: "bold", size: "sm", wrap: true, maxLines: 3 },
          { type: "text", text: meta, size: "xxs", color: "#8a8f9c", wrap: true },
        ],
      },
      footer: {
        type: "box", layout: "vertical",
        contents: [{ type: "button", style: "primary", color: "#4a63e0", height: "sm", action: { type: "uri", label: th ? "เปิดไฟล์" : "Open file", uri: f.url } }],
      },
    },
  };
}

/** ส่งไฟล์: การ์ดไฟล์ แล้วตามด้วย caption */
export async function lineSendFile(userId: string, file: LineFile, caption: string, replyToken?: string, meta: LineSendMeta = DEFAULT_META) {
  const messages: LineMessage[] = [lineFileCard(file)];
  if (caption.trim()) messages.push({ type: "text", text: caption.slice(0, 5000) });
  return lineSendMessages(userId, messages, replyToken, meta);
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

/** โควตาข้อความ push ของเดือนนี้ type none = ไม่จำกัด */
export async function lineQuota(): Promise<{ type: string; limit: number | null; used: number }> {
  const get = async (path: string) => {
    const res = await fetch(`${API}/message/${path}`, { headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`LINE ${path} failed ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const [quota, consumption] = await Promise.all([get("quota"), get("quota/consumption")]);
  return {
    type: String(quota.type ?? "none"),
    limit: typeof quota.value === "number" ? quota.value : null,
    used: Number(consumption.totalUsage ?? 0),
  };
}

/** ข้อความตัวอักษร: ใช้ replyToken ก่อนถ้ามี ไม่สำเร็จค่อย push */
export async function lineSend(userId: string, text: string, replyToken?: string, meta: LineSendMeta = DEFAULT_META) {
  return lineSendMessages(userId, [{ type: "text", text: text.slice(0, 5000) }], replyToken, meta);
}
