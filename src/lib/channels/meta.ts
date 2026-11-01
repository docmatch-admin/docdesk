import crypto from "node:crypto";

/**
 * Facebook Messenger + Instagram Direct (ผ่าน Facebook Page ที่เชื่อม IG Professional account)
 * ใช้ Page access token ตัวเดียวกันทั้งสองช่องทาง
 */
const VERSION = () => process.env.META_GRAPH_VERSION || "v25.0";
const GRAPH = () => `https://graph.facebook.com/${VERSION()}`;
const pageToken = () => process.env.META_PAGE_ACCESS_TOKEN!;

const DAY = 24 * 60 * 60 * 1000;

/** ตรวจ X-Hub-Signature-256 = "sha256=" + HMAC(app secret, raw body) */
export function verifyMetaSignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header.slice(7));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function getMetaProfile(
  kind: "facebook" | "instagram",
  userId: string,
): Promise<{ name?: string; avatar?: string }> {
  const fields = kind === "facebook" ? "first_name,last_name,profile_pic" : "name,username,profile_pic";
  const res = await fetch(`${GRAPH()}/${userId}?fields=${fields}&access_token=${pageToken()}`);
  if (!res.ok) return {};
  const p = (await res.json()) as Record<string, string | undefined>;
  const name = kind === "facebook"
    ? [p.first_name, p.last_name].filter(Boolean).join(" ")
    : p.name || (p.username ? `@${p.username}` : undefined);
  return { name: name || undefined, avatar: p.profile_pic };
}

/** แบ่งข้อความยาว: Messenger ≤ 2000 ตัวอักษร, Instagram ≤ 1000 bytes */
export function splitForMeta(kind: "facebook" | "instagram", text: string): string[] {
  const fits = (s: string) =>
    kind === "instagram" ? Buffer.byteLength(s, "utf8") <= 1000 : [...s].length <= 2000;
  const out: string[] = [];
  let cur = "";
  for (const ch of [...text]) {
    if (!fits(cur + ch)) {
      // ตัดที่ช่องว่าง/ขึ้นบรรทัดล่าสุดถ้ามี
      const cut = Math.max(cur.lastIndexOf("\n"), cur.lastIndexOf(" "));
      if (cut > cur.length * 0.6) {
        out.push(cur.slice(0, cut).trimEnd());
        cur = cur.slice(cut + 1);
      } else {
        out.push(cur);
        cur = "";
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export class MetaWindowError extends Error {}

/**
 * กติกาเวลาของ Meta:
 * - ภายใน 24 ชม. หลังลูกค้าทักล่าสุด → ส่งได้ปกติ (RESPONSE)
 * - 24 ชม.–7 วัน → ส่งได้เฉพาะเจ้าหน้าที่ตัวจริง ด้วย tag HUMAN_AGENT (แอปต้องได้สิทธิ์ Human Agent จาก Meta)
 * - เกิน 7 วัน → ส่งไม่ได้ รอลูกค้าทักมาก่อน
 */
export function metaMessagingType(lastInboundAt: Date | null, senderType: "staff" | "ai", now = Date.now()) {
  const age = lastInboundAt ? now - lastInboundAt.getTime() : Infinity;
  if (age <= DAY) return { messaging_type: "RESPONSE" as const };
  if (age <= 7 * DAY && senderType === "staff") {
    return { messaging_type: "MESSAGE_TAG" as const, tag: "HUMAN_AGENT" as const };
  }
  throw new MetaWindowError(
    senderType === "ai"
      ? "เกิน 24 ชั่วโมงแล้ว AI ส่งข้อความทาง Facebook/Instagram ไม่ได้"
      : "เกิน 7 วันหลังลูกค้าทักล่าสุด Facebook/Instagram ไม่อนุญาตให้ส่ง ต้องรอลูกค้าทักมาก่อน",
  );
}

export async function metaSend(
  kind: "facebook" | "instagram",
  recipientId: string,
  text: string,
  opts: { lastInboundAt: Date | null; senderType: "staff" | "ai" },
) {
  const type = metaMessagingType(opts.lastInboundAt, opts.senderType);
  for (const part of splitForMeta(kind, text)) {
    const res = await fetch(`${GRAPH()}/me/messages?access_token=${pageToken()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text: part }, ...type }),
    });
    if (!res.ok) {
      const body = await res.text();
      if (type.messaging_type === "MESSAGE_TAG" && /permission|tag/i.test(body)) {
        throw new MetaWindowError(
          "เกิน 24 ชั่วโมงแล้ว และแอปยังไม่ได้สิทธิ์ Human Agent จาก Meta จึงส่งไม่ได้ ต้องรอลูกค้าทักมาก่อน",
        );
      }
      throw new Error(`Meta send failed ${res.status}: ${body}`);
    }
  }
}

// ---------------------------------------------------------------------------
// แปลง webhook payload → ข้อความเข้า
// ---------------------------------------------------------------------------
export interface MetaIncoming {
  kind: "facebook" | "instagram";
  senderId: string;
  messageId: string;
  text: string;
  isText: boolean;
}

interface MetaWebhookBody {
  object?: string;
  entry?: {
    id: string;
    messaging?: {
      sender?: { id: string };
      recipient?: { id: string };
      message?: {
        mid: string;
        text?: string;
        is_echo?: boolean;
        attachments?: { type: string }[];
      };
    }[];
  }[];
}

const ATTACHMENT_TH: Record<string, string> = {
  image: "รูปภาพ", video: "วิดีโอ", audio: "ข้อความเสียง", file: "ไฟล์",
  sticker: "สติกเกอร์", story_mention: "การแท็กในสตอรี่", share: "โพสต์ที่แชร์", reel: "รีล",
};

export function parseMetaWebhook(body: MetaWebhookBody): MetaIncoming[] {
  const kind = body.object === "page" ? "facebook" : body.object === "instagram" ? "instagram" : null;
  if (!kind) return [];
  const out: MetaIncoming[] = [];
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const m = ev.message;
      const senderId = ev.sender?.id;
      // ข้าม echo (ข้อความที่เพจส่งเอง) และข้อความที่ผู้ส่งคือเพจ/บัญชีเราเอง
      if (!m || m.is_echo || !senderId || senderId === entry.id) continue;
      if (m.text) {
        out.push({ kind, senderId, messageId: m.mid, text: m.text, isText: true });
      } else if (m.attachments?.length) {
        const t = m.attachments[0].type;
        out.push({
          kind, senderId, messageId: m.mid, isText: false,
          text: `[ลูกค้าส่ง${ATTACHMENT_TH[t] ?? t} — เปิดดูใน ${kind === "facebook" ? "Meta Business Suite" : "Instagram"}]`,
        });
      }
    }
  }
  return out;
}
