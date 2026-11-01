import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { createUploadSlot } from "@/lib/media-store";

export const runtime = "nodejs";

/** เจ้าหน้าที่ขอช่องอัปโหลดตรงเข้า Storage เพราะ Vercel รับ request ได้ไม่เกิน 4.5MB */
export async function POST() {
  const { error } = await requireStaff();
  if (error) return error;
  try {
    return NextResponse.json(await createUploadSlot("staff"));
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "อัปโหลดไม่สำเร็จ" }, { status: 500 });
  }
}
