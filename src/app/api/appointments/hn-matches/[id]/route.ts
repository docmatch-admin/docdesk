import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { appointmentErrorResponse } from "@/lib/appointment-http";
import { decideHnMatch } from "@/lib/appointment-store";

export const runtime = "nodejs";

/** { accept: boolean } แอดมินยืนยันหรือปฏิเสธการจับคู่ HN */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as { accept?: unknown };
  if (typeof b.accept !== "boolean") return NextResponse.json({ error: "ระบุ accept" }, { status: 400 });
  try {
    return NextResponse.json(await decideHnMatch(id, b.accept, user.id));
  } catch (e) {
    return appointmentErrorResponse(e);
  }
}
