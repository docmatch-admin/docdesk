import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { setPresence } from "@/lib/push-store";

export const runtime = "nodejs";

/** หน้าแชทแจ้งทุก ~30 วิว่ากำลังเปิดแชทไหนอยู่ (หน้าจอเปิดอยู่) → ไม่ส่ง push ของแชทนั้นให้คนที่ดูอยู่ · null = เลิกดู */
export async function POST(req: Request) {
  const { user, error } = await requireStaff();
  if (error) return error;
  const { conversationId } = (await req.json().catch(() => ({}))) as { conversationId?: unknown };
  const id = typeof conversationId === "string" && /^[0-9a-f-]{36}$/i.test(conversationId) ? conversationId : null;
  await setPresence(user.id, id);
  return NextResponse.json({ ok: true });
}
