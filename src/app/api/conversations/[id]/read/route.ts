import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { markConversationRead } from "@/lib/pipeline";

export const runtime = "nodejs";

/** เจ้าหน้าที่เปิดอ่านแชท: แจ้งแพลตฟอร์มให้ลูกค้าเห็นว่าอ่านแล้ว */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  return NextResponse.json({ result: await markConversationRead(id) });
}
