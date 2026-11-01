import type { ChannelType } from "../types";
import { lineSend } from "./line";
import { metaSend } from "./meta";

export interface SendOptions {
  /** LINE replyToken (ถ้ายังไม่หมดอายุ จะใช้แทน push เพื่อประหยัดโควต้า) */
  replyToken?: string;
  /** Facebook/Instagram: เวลาที่ลูกค้าทักล่าสุด (ใช้ตัดสินกติกา 24 ชม.) */
  lastInboundAt?: Date | null;
  senderType?: "staff" | "ai";
}

/**
 * ส่งข้อความออกไปยังแพลตฟอร์มของลูกค้า
 * - web: ไม่ต้องทำอะไร widget ดึงข้อความจากฐานข้อมูลเอง
 * - whatsapp: เพิ่มในเฟสถัดไป
 */
export async function sendToChannel(type: ChannelType, externalId: string, text: string, opts: SendOptions = {}) {
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
