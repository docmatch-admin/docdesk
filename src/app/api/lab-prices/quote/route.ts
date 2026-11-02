import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { buildQuoteMessage, DEFAULT_B2B_RULES, normalizeB2bRules, quoteB2b } from "@/lib/lab-pricing";
import { getSetting } from "@/lib/mode";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** ใบเสนอราคา B2B: คำนวณที่ server เพราะต้องใช้ต้นทุน */
export async function POST(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const { code, count } = (await req.json().catch(() => ({}))) as { code?: string; count?: number };
  if (!code || !Number.isInteger(count) || (count as number) < 1 || (count as number) > 100000) {
    return NextResponse.json({ error: "เลือกแพ็กเกจและกรอกจำนวนพนักงานให้ถูกต้อง" }, { status: 400 });
  }
  const { data: pkg } = await supabaseAdmin().from("lab_packages").select("name, price, cost, active").eq("code", code).maybeSingle();
  if (!pkg?.active) return NextResponse.json({ error: "ไม่พบแพ็กเกจ" }, { status: 404 });
  if (pkg.cost == null) return NextResponse.json({ error: "แพ็กเกจนี้ยังไม่ได้ตั้งทุน" }, { status: 400 });

  const rules = normalizeB2bRules(await getSetting<unknown>("lab_b2b_rules", DEFAULT_B2B_RULES));
  const quote = quoteB2b({ price: Number(pkg.price), cost: Number(pkg.cost) }, count as number, rules);
  return NextResponse.json({ quote, message: buildQuoteMessage(pkg.name as string, quote), rules });
}
