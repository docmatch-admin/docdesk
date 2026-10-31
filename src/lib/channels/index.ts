import type { ChannelType } from "../types";
import { linePush, lineReply } from "./line";

export interface SendOptions {
  /** LINE replyToken (ถ้ายังไม่หมดอายุ จะใช้แทน push เพื่อประหยัดโควต้า) */
  replyToken?: string;
}

/**
 * ส่งข้อความออกไปยังแพลตฟอร์มของลูกค้า
 * - web: ไม่ต้องทำอะไร widget ดึงข้อความจากฐานข้อมูลเอง
 * - facebook / instagram / whatsapp: เพิ่มในเฟสถัดไป
 */
export async function sendToChannel(type: ChannelType, externalId: string, text: string, opts: SendOptions = {}) {
  switch (type) {
    case "line":
      if (opts.replyToken && (await lineReply(opts.replyToken, text))) return;
      return linePush(externalId, text);
    case "web":
      return;
    default:
      throw new Error(`ยังไม่รองรับการส่งไปช่องทาง ${type}`);
  }
}
