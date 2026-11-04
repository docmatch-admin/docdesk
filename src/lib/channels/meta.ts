import crypto from "node:crypto";

/**
 * Facebook Messenger + Instagram Direct (ผ่าน Facebook Page ที่เชื่อม IG Professional account)
 * ใช้ Page access token ตัวเดียวกันทั้งสองช่องทาง
 */
const VERSION = () => process.env.META_GRAPH_VERSION || "v25.0";
const GRAPH = () => `https://graph.facebook.com/${VERSION()}`;
const pageToken = () => process.env.META_PAGE_ACCESS_TOKEN!;

const DAY = 24 * 60 * 60 * 1000;

/** แอป DocDesk ใน Meta: echo จากแอปนี้คือข้อความที่ DocDesk ส่งเอง */
export const DOCDESK_META_APP_ID = () => process.env.META_APP_ID || "1140939055044630";

/** Meta ตอบ message_id ของแต่ละข้อความ ใช้กัน echo ซ้ำ ถ้าอ่านไม่ได้ไม่ถือว่าส่งล้ม */
async function sentMid(res: Response): Promise<string | null> {
  const j = (await res.json().catch(() => null)) as { message_id?: string } | null;
  return j?.message_id ?? null;
}

/** ตรวจ X-Hub-Signature-256 = "sha256=" + HMAC(app secret, raw body) */
export function verifyMetaSignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header.slice(7));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** ชื่อชั่วคราวเมื่อดึงโปรไฟล์ไม่ได้ เช่น แอปยังไม่มีสิทธิ์ ข้อความต้องเข้าระบบได้เสมอ */
export const META_FALLBACK_NAME = { facebook: "ลูกค้า Facebook", instagram: "ลูกค้า Instagram" } as const;

export async function getMetaProfile(
  kind: "facebook" | "instagram",
  userId: string,
): Promise<{ name?: string; avatar?: string }> {
  const fallback = { name: META_FALLBACK_NAME[kind] };
  const fields = kind === "facebook" ? "first_name,last_name,profile_pic" : "name,username,profile_pic";
  try {
    const res = await fetch(`${GRAPH()}/${userId}?fields=${fields}&access_token=${pageToken()}`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return fallback;
    const p = (await res.json()) as Record<string, string | undefined>;
    const name = kind === "facebook"
      ? [p.first_name, p.last_name].filter(Boolean).join(" ")
      : p.name || (p.username ? `@${p.username}` : undefined);
    return { name: name || fallback.name, avatar: p.profile_pic };
  } catch (e) {
    // ไม่ log ตัว error เพราะข้อความอาจมี URL ที่มี token
    console.error("meta profile failed", e instanceof Error ? e.name : "error");
    return fallback;
  }
}

/** ตรวจ Page token ด้วย debug_token ไม่ใช้ /me เพราะต้องมีสิทธิ์ pages_read_engagement */
export async function debugPageToken(): Promise<{ ok: boolean; detail: string }> {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) return { ok: false, detail: "ยังไม่ได้ตั้ง META_PAGE_ACCESS_TOKEN" };
  const t = encodeURIComponent(token);
  const res = await fetch(`${GRAPH()}/debug_token?input_token=${t}&access_token=${t}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return { ok: false, detail: `Meta ตอบ ${res.status}` };
  const { data } = (await res.json()) as { data?: { type?: string; is_valid?: boolean; profile_id?: string; expires_at?: number } };
  if (!data?.is_valid) return { ok: false, detail: "token ใช้ไม่ได้แล้ว" };
  if (data.type !== "PAGE") return { ok: false, detail: `ไม่ใช่ Page token (${data.type ?? "ไม่ทราบ"})` };
  const expiry = data.expires_at ? `หมดอายุ ${new Date(data.expires_at * 1000).toISOString().slice(0, 10)}` : "ไม่หมดอายุ";
  return { ok: true, detail: `Page ${data.profile_id ?? "-"} ${expiry}` };
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
): Promise<string[]> {
  const type = metaMessagingType(opts.lastInboundAt, opts.senderType);
  const mids: string[] = [];
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
    const mid = await sentMid(res);
    if (mid) mids.push(mid);
  }
  return mids;
}

/** ส่งรูปหรือไฟล์ตามกติกาเวลาเดียวกับข้อความ caption ไปเป็นข้อความถัดไปเพราะ attachment ไม่มี caption */
async function metaSendAttachment(
  kind: "facebook" | "instagram",
  recipientId: string,
  type: "image" | "file",
  url: string,
  caption: string,
  opts: { lastInboundAt: Date | null; senderType: "staff" | "ai" },
): Promise<string[]> {
  const messaging = metaMessagingType(opts.lastInboundAt, opts.senderType);
  const res = await fetch(`${GRAPH()}/me/messages?access_token=${pageToken()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { attachment: { type, payload: { url } } },
      ...messaging,
    }),
  });
  if (!res.ok) throw new Error(`Meta send ${type} failed ${res.status}: ${await res.text()}`);
  const mid = await sentMid(res);
  const captionMids = caption.trim() ? await metaSend(kind, recipientId, caption, opts) : [];
  return [...(mid ? [mid] : []), ...captionMids];
}

export async function metaSendImage(
  kind: "facebook" | "instagram",
  recipientId: string,
  imageUrl: string,
  caption: string,
  opts: { lastInboundAt: Date | null; senderType: "staff" | "ai" },
): Promise<string[]> {
  return metaSendAttachment(kind, recipientId, "image", imageUrl, caption, opts);
}

/** ไฟล์ PDF: Messenger และ Instagram รับ attachment type file ได้ถึง 25MB Meta ดึงไฟล์จาก url ทันที */
export async function metaSendFile(
  kind: "facebook" | "instagram",
  recipientId: string,
  fileUrl: string,
  caption: string,
  opts: { lastInboundAt: Date | null; senderType: "staff" | "ai" },
): Promise<string[]> {
  return metaSendAttachment(kind, recipientId, "file", fileUrl, caption, opts);
}

/** แจ้ง Facebook/Instagram ว่าเพจอ่านแล้ว */
export async function metaMarkSeen(_kind: "facebook" | "instagram", recipientId: string) {
  const res = await fetch(`${GRAPH()}/me/messages?access_token=${pageToken()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientId }, sender_action: "mark_seen" }),
  });
  if (!res.ok) throw new Error(`Meta mark_seen failed ${res.status}: ${await res.text()}`);
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
  /** รูปภาพ: ลิงก์หมดอายุเร็ว ต้องดาวน์โหลดทันที */
  imageUrl?: string;
  /** ไฟล์: ดาวน์โหลดทันทีเหมือนรูป เก็บเฉพาะ PDF */
  fileUrl?: string;
}

interface MetaWebhookBody {
  object?: string;
  entry?: {
    id: string;
    messaging?: {
      sender?: { id: string };
      recipient?: { id: string };
      timestamp?: number;
      read?: { watermark?: number };
      message?: {
        mid: string;
        text?: string;
        is_echo?: boolean;
        app_id?: number | string;
        metadata?: string;
        attachments?: { type: string; payload?: { url?: string } }[];
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
      } else if (m.attachments?.some((a) => a.type === "image" && a.payload?.url)) {
        // ส่งหลายรูปพร้อมกันได้ mid เดียว ต้องแยก id ไม่อย่างนั้นตัวกันซ้ำจะทิ้งรูปที่เหลือ
        m.attachments.filter((a) => a.type === "image" && a.payload?.url).forEach((a, i) => {
          out.push({ kind, senderId, messageId: i ? `${m.mid}:${i}` : m.mid, text: "", isText: false, imageUrl: a.payload!.url });
        });
      } else if (m.attachments?.some((a) => a.type === "file" && a.payload?.url)) {
        m.attachments.filter((a) => a.type === "file" && a.payload?.url).forEach((a, i) => {
          out.push({ kind, senderId, messageId: i ? `${m.mid}:${i}` : m.mid, text: "", isText: false, fileUrl: a.payload!.url });
        });
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

// ---------------------------------------------------------------------------
// echo: ข้อความที่เพจส่งออก ทั้งจาก DocDesk, คนตอบใน Meta Business Suite และข้อความอัตโนมัติของเพจ
// ---------------------------------------------------------------------------
export interface MetaEcho {
  kind: "facebook" | "instagram";
  /** ลูกค้าคือผู้รับ ไม่ใช่ผู้ส่ง */
  customerId: string;
  messageId: string;
  text: string;
  appId: string | null;
  metadata: string | null;
  sentAt: string;
}

export function parseMetaEchoes(body: MetaWebhookBody): MetaEcho[] {
  const kind = body.object === "page" ? "facebook" : body.object === "instagram" ? "instagram" : null;
  if (!kind) return [];
  const out: MetaEcho[] = [];
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const m = ev.message;
      const customerId = ev.recipient?.id;
      if (!m?.is_echo || !m.mid || !customerId || customerId === entry.id) continue;
      const attachment = m.attachments?.[0]?.type;
      const text = m.text ?? (attachment ? `[ส่ง${ATTACHMENT_TH[attachment] ?? attachment}จากเพจ]` : "");
      if (!text) continue;
      out.push({
        kind, customerId, messageId: m.mid, text,
        appId: m.app_id == null ? null : String(m.app_id),
        metadata: m.metadata?.trim() || null,
        sentAt: new Date(ev.timestamp ?? Date.now()).toISOString(),
      });
    }
  }
  return out;
}

export type EchoKind = "own" | "auto" | "staff";

/**
 * own = DocDesk ส่งเอง (กันกรณี echo มาก่อนบันทึก mid)
 * auto = ข้อความอัตโนมัติของเพจ: มี metadata หรือมาจากแอปที่ตั้งไว้ใน meta_auto_reply_app_ids
 * staff = คนตอบนอก DocDesk
 */
export function classifyMetaEcho(echo: Pick<MetaEcho, "appId" | "metadata">, autoReplyAppIds: string[]): EchoKind {
  if (echo.appId === DOCDESK_META_APP_ID()) return "own";
  if (echo.metadata || (echo.appId && autoReplyAppIds.includes(echo.appId))) return "auto";
  return "staff";
}

export interface MetaRead {
  kind: "facebook" | "instagram";
  senderId: string;
  watermark: number;  // ms: ข้อความที่ส่งไม่เกินเวลานี้ถือว่าอ่านแล้ว
  readAt: number;     // ms
}

/** Messenger ส่ง read.watermark ส่วนเอกสาร Instagram (messaging_seen) ไม่ระบุว่ามี จึงใช้เวลาของ event แทน */
export function parseMetaReads(body: MetaWebhookBody): MetaRead[] {
  const kind = body.object === "page" ? "facebook" : body.object === "instagram" ? "instagram" : null;
  if (!kind) return [];
  const out: MetaRead[] = [];
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const senderId = ev.sender?.id;
      if (!ev.read || !senderId || senderId === entry.id) continue;
      const watermark = ev.read.watermark ?? ev.timestamp;
      if (!watermark) continue;
      out.push({ kind, senderId, watermark, readAt: ev.timestamp ?? watermark });
    }
  }
  return out;
}
