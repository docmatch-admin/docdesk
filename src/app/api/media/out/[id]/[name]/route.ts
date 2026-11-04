import { serveOutMedia } from "@/lib/media-out";

export const runtime = "nodejs";

/** ไฟล์ขาออกที่มีชื่อไฟล์ต่อท้าย URL ชื่อใช้แสดงผลเท่านั้น สิทธิ์ตรวจจากลายเซ็นของ id */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id } = await params;
  return serveOutMedia(req, id);
}
