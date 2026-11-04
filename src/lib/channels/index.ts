import type { ChannelType } from "../types";
import { lineSend, lineSendFile, lineSendImage } from "./line";
import { metaSend, metaSendFile, metaSendImage } from "./meta";

export interface SendOptions {
  /** LINE replyToken (ถ้ายังไม่หมดอายุ จะใช้แทน push เพื่อประหยัดโควต้า) */
  replyToken?: string;
  /** Facebook/Instagram: เวลาที่ลูกค้าทักล่าสุด (ใช้ตัดสินกติกา 24 ชม.) */
  lastInboundAt?: Date | null;
  senderType?: "staff" | "ai";
}

/** ส่งรูป: web ไม่ต้องทำอะไร widget ดึงจากฐานข้อมูลเอง Facebook/Instagram คืน message id ที่ใช้กัน echo ซ้ำ */
export async function sendImageToChannel(
  type: ChannelType,
  externalId: string,
  urls: { main: string; preview: string },
  caption: string,
  opts: SendOptions = {},
): Promise<string[] | void> {
  switch (type) {
    case "line":
      return lineSendImage(externalId, urls.main, urls.preview, caption, opts.replyToken);
    case "facebook":
    case "instagram":
      return metaSendImage(type, externalId, urls.main, caption, {
        lastInboundAt: opts.lastInboundAt ?? null,
        senderType: opts.senderType ?? "staff",
      });
    case "web":
      return;
    default:
      throw new Error(`ยังไม่รองรับการส่งรูปไปช่องทาง ${type}`);
  }
}

export interface OutFile { url: string; name: string; sizeText?: string; expiresAt: Date; language?: string }

/**
 * ส่งไฟล์ (PDF) ปุ่มเดียวกันทุกช่องทาง หลังบ้านเลือกวิธีตามแพลตฟอร์ม
 * - Facebook/Instagram: ไฟล์จริง
 * - LINE: API ไม่มีข้อความประเภทไฟล์ จึงส่งการ์ดพร้อมปุ่มเปิดไฟล์
 * - web: widget ดึงจากฐานข้อมูลเอง
 */
export async function sendFileToChannel(
  type: ChannelType,
  externalId: string,
  file: OutFile,
  caption: string,
  opts: SendOptions = {},
): Promise<string[] | void> {
  switch (type) {
    case "line":
      return lineSendFile(externalId, file, caption, opts.replyToken);
    case "facebook":
    case "instagram":
      return metaSendFile(type, externalId, file.url, caption, {
        lastInboundAt: opts.lastInboundAt ?? null,
        senderType: opts.senderType ?? "staff",
      });
    case "web":
      return;
    default:
      throw new Error(`ยังไม่รองรับการส่งไฟล์ไปช่องทาง ${type}`);
  }
}

/**
 * ส่งข้อความออกไปยังแพลตฟอร์มของลูกค้า
 * - web: ไม่ต้องทำอะไร widget ดึงข้อความจากฐานข้อมูลเอง
 * - whatsapp: เพิ่มในเฟสถัดไป
 */
export async function sendToChannel(type: ChannelType, externalId: string, text: string, opts: SendOptions = {}): Promise<string[] | void> {
  switch (type) {
    case "line":
      return lineSend(externalId, text, opts.replyToken);
    case "facebook":
    case "instagram":
      return metaSend(type, externalId, text, {
        lastInboundAt: opts.lastInboundAt ?? null,
        senderType: opts.senderType ?? "staff",
      });
    case "web":
      return;
    default:
      throw new Error(`ยังไม่รองรับการส่งไปช่องทาง ${type}`);
  }
}
