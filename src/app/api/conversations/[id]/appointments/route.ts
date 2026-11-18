import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { conversationAppointments } from "@/lib/conversation-appointments";

export const runtime = "nodejs";

/** กล่องนัดของแชท (ดู conversationAppointments) */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  return NextResponse.json(await conversationAppointments(id), { headers: { "Cache-Control": "no-store" } });
}
