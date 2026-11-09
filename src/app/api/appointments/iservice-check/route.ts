import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * แอดมินตรวจการเชื่อม iService ทีละขั้น (login → token → ovst_list วันนี้)
 * คืนเฉพาะสถานะ โครงสร้างคำตอบ และจำนวนรายการ ไม่มีค่าลับหรือข้อมูลคนไข้
 */
export async function GET(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "ยังไม่ได้ตั้ง Supabase URL/key ของแอป" }, { status: 500 });
  const params = new URL(req.url).searchParams;
  const search = params.get("search");
  try {
    const res = await fetch(`${url}/functions/v1/iservice`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify(search !== null
        ? { action: "patients", q: search }
        : params.get("simulate") === "down"
          ? { action: "visits", simulate_down: true }
          : { action: "diagnose", q: params.get("q") ?? "" }),
      signal: AbortSignal.timeout(55_000),
    });
    const body = await res.json().catch(() => null);
    if (search !== null) {
      // ทดสอบการค้น: คืนเฉพาะจำนวน HN และว่ามีชื่อ/เบอร์หรือไม่ ไม่ส่งชื่อ เบอร์ หรือเลขบัตร
      const list = (body?.patients ?? []) as { hn: string; name?: string; phone?: string; lineLinked?: boolean }[];
      return NextResponse.json({
        function_status: res.status, kind: body?.kind ?? null, source: body?.source ?? null, cached: !!body?.cached,
        count: list.length,
        results: list.map((p) => ({ hn: p.hn, has_name: !!p.name, has_phone: !!p.phone, line: !!p.lineLinked })),
        error: body?.error ?? null,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ function_status: res.status, result: body }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "เรียก Edge Function ไม่สำเร็จ" }, { status: 502 });
  }
}
