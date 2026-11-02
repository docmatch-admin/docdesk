import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const moneyOrNull = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

/** ราคาพร้อมต้นทุน: เฉพาะ admin */
export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  const db = supabaseAdmin();
  const [{ data: items }, { data: packages }] = await Promise.all([
    db.from("lab_items").select("code, name_en, name_th, tube, cost, price, category, active").order("category").order("code"),
    db.from("lab_packages").select("code, name, price, cost, includes, compare_item_codes, items_without_single_price, active").order("price"),
  ]);
  return NextResponse.json({ items: items ?? [], packages: packages ?? [] });
}

/** เพิ่มรายการเดี่ยว */
export async function POST(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as {
    code?: string; name_en?: string; name_th?: string; category?: string; tube?: string | null; price?: number | null; cost?: number | null;
  };
  const code = b.code?.trim().toUpperCase();
  if (!code || !/^[A-Z0-9_]{1,30}$/.test(code) || !b.name_en?.trim()) {
    return NextResponse.json({ error: "กรอกรหัสและชื่อรายการให้ถูกต้อง" }, { status: 400 });
  }
  if (!moneyOrNull(b.price ?? null) || !moneyOrNull(b.cost ?? null)) {
    return NextResponse.json({ error: "ราคาหรือทุนไม่ถูกต้อง" }, { status: 400 });
  }
  const { error: dbError } = await supabaseAdmin().from("lab_items").insert({
    code,
    name_en: b.name_en.trim(),
    name_th: b.name_th?.trim() ?? "",
    category: b.category?.trim() || "อื่นๆ",
    tube: b.tube?.trim() || null,
    price: b.price ?? null,
    cost: b.cost ?? null,
  });
  if (dbError) {
    return NextResponse.json({ error: dbError.code === "23505" ? "มีรหัสนี้แล้ว" : "บันทึกไม่สำเร็จ" }, { status: 400 });
  }
  return NextResponse.json({ code });
}

/** แก้ราคา ทุน หรือเปิดปิด */
export async function PATCH(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as {
    kind?: string; code?: string; price?: number | null; cost?: number | null; active?: boolean;
  };
  const table = b.kind === "package" ? "lab_packages" : b.kind === "item" ? "lab_items" : null;
  if (!table || !b.code) return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.price !== undefined) {
    // แพ็กเกจต้องมีราคาเสมอ รายการเดี่ยวเว้นว่างได้ แปลว่ายังไม่มีราคาเดี่ยว
    if (!moneyOrNull(b.price) || (table === "lab_packages" && b.price === null)) return NextResponse.json({ error: "ราคาไม่ถูกต้อง" }, { status: 400 });
    patch.price = b.price;
  }
  if (b.cost !== undefined) {
    if (!moneyOrNull(b.cost)) return NextResponse.json({ error: "ทุนไม่ถูกต้อง" }, { status: 400 });
    patch.cost = b.cost;
  }
  if (b.active !== undefined) patch.active = !!b.active;

  const { data, error: dbError } = await supabaseAdmin().from(table).update(patch).eq("code", b.code).select("code");
  if (dbError) return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  if (!data?.length) return NextResponse.json({ error: "ไม่พบรายการ" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
