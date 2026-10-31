import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { generateSuggestions } from "@/lib/suggest";

export const runtime = "nodejs";
export const maxDuration = 60;

/** ขอคำแนะนำใหม่ (กดปุ่ม "แนะนำใหม่") */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await generateSuggestions(id));
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "สร้างคำแนะนำไม่สำเร็จ" }, { status: 500 });
  }
}
