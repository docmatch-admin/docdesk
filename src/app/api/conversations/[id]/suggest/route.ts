import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { ensureSuggestions, generateSuggestions } from "@/lib/suggest";

export const runtime = "nodejs";
export const maxDuration = 60;

/** ?ensure=1 = เปิดแชท (สร้างเมื่อยังไม่มี) ไม่มี query = กดปุ่ม "แนะนำใหม่" (เรียก LLM เสมอ) */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const ensure = new URL(req.url).searchParams.get("ensure") === "1";
  try {
    return NextResponse.json(ensure ? await ensureSuggestions(id) : await generateSuggestions(id, { force: true }));
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "สร้างคำแนะนำไม่สำเร็จ" }, { status: 500 });
  }
}
