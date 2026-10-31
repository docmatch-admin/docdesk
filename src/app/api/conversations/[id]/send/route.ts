import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { sendReply } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    text?: string; suggestionId?: string | null; chosenIndex?: number | null; skipTranslate?: boolean;
  };
  if (!body.text?.trim()) return NextResponse.json({ error: "ข้อความว่าง" }, { status: 400 });

  try {
    const res = await sendReply({
      conversationId: id,
      textTh: body.text.trim(),
      senderType: "staff",
      senderId: user.id,
      suggestionId: body.suggestionId ?? null,
      chosenIndex: body.chosenIndex ?? null,
      skipTranslate: !!body.skipTranslate,
    });
    return NextResponse.json(res);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "ส่งไม่สำเร็จ" }, { status: 500 });
  }
}
