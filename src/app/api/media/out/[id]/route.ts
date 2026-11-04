import { serveOutMedia } from "@/lib/media-out";

export const runtime = "nodejs";

/** รูปขาออกให้ LINE/Meta ดึง: ไม่ต้องล็อกอินเพราะแพลตฟอร์มต้องดึงได้ ป้องกันด้วยลายเซ็นที่หมดอายุ */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return serveOutMedia(req, id);
}
