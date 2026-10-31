import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { starMessage } from "@/lib/pipeline";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  try {
    await starMessage(id, user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "ไม่สำเร็จ" }, { status: 400 });
  }
}
