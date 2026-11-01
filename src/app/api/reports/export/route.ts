import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { bangkokRange, buildTagCsv, isValidDate, type ExportRow } from "@/lib/tags";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

const PAGE = 1000;

/** ส่งออกรายชื่อแชทตามแท็ก: มีเฉพาะชื่อที่แสดง ช่องทาง แท็ก และวันที่ */
export async function GET(req: Request) {
  const { error } = await requireStaff();
  if (error) return error;
  const q = new URL(req.url).searchParams;
  const from = q.get("from");
  const to = q.get("to");
  if (!isValidDate(from) || !isValidDate(to)) return NextResponse.json({ error: "วันที่ไม่ถูกต้อง" }, { status: 400 });

  const range = bangkokRange(from, to);
  const sb = await supabaseServer();
  const rows: ExportRow[] = [];
  // PostgREST คืนไม่เกิน 1000 แถวต่อครั้ง ต้องไล่ทีละหน้า ไม่อย่างนั้นไฟล์จะขาดเงียบๆ
  for (let start = 0; ; start += PAGE) {
    const { data, error: dbError } = await sb
      .rpc("tag_report_chats", { p_tag: q.get("tag") || null, p_from: range.from, p_to: range.to })
      .range(start, start + PAGE - 1);
    if (dbError) {
      console.error(dbError);
      return NextResponse.json({ error: "ส่งออกไม่สำเร็จ" }, { status: 500 });
    }
    rows.push(...((data ?? []) as ExportRow[]));
    if ((data ?? []).length < PAGE) break;
  }

  return new NextResponse(buildTagCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="docdesk-tags-${from}-${to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
