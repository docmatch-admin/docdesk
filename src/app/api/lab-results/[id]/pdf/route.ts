import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { labErrorResponse } from "@/lib/lab-http";
import { staffPdfUrl } from "@/lib/lab-results-store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** เจ้าหน้าที่เปิด PDF: redirect ไป signed URL อายุ 10 นาที (ไม่นับเป็นการเปิดดูของคนไข้) */
export async function GET(_req: Request, { params }: Ctx) {
  const { error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.redirect(await staffPdfUrl(id), { status: 303, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return labErrorResponse(e, "lab-results:pdf");
  }
}
