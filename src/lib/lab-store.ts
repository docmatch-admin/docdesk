import { buildLabContext, isLabQuestion, type LabItem, type LabPackage } from "./lab-pricing";
import { supabaseAdmin } from "./supabase/admin";

/** ระบุคอลัมน์ทุกครั้ง ที่นี่ใช้ service role ซึ่งอ่านต้นทุนได้ ห้ามใช้ select("*") */
export const LAB_ITEM_COLUMNS = "code, name_en, name_th, price, category, active";
export const LAB_PACKAGE_COLUMNS = "code, name, price, includes, compare_item_codes, items_without_single_price, active";

/** ถอดเฉพาะฟิลด์ที่อนุญาต กันต้นทุนติดมาถ้าเปลี่ยนคำสั่ง select ภายหลัง */
export function toSafeItem(r: LabItem): LabItem {
  return { code: r.code, name_en: r.name_en, name_th: r.name_th, price: r.price, category: r.category, active: r.active };
}
export function toSafePackage(r: LabPackage): LabPackage {
  return {
    code: r.code, name: r.name, price: r.price, includes: r.includes,
    compare_item_codes: r.compare_item_codes, items_without_single_price: r.items_without_single_price, active: r.active,
  };
}

/** ข้อมูลราคาแล็บสำหรับ prompt ถ้าคำถามไม่เกี่ยวคืน null เพื่อไม่เพิ่มขนาด prompt */
export async function loadLabContext(question: string, tags: string[]): Promise<string | null> {
  const db = supabaseAdmin();
  const [{ data: items }, { data: packages }] = await Promise.all([
    db.from("lab_items").select(LAB_ITEM_COLUMNS).order("code"),
    db.from("lab_packages").select(LAB_PACKAGE_COLUMNS).order("price"),
  ]);
  const safeItems = ((items ?? []) as unknown as LabItem[]).map(toSafeItem);
  const safePackages = ((packages ?? []) as unknown as LabPackage[]).map(toSafePackage);
  if (!safeItems.length || !isLabQuestion(question, tags, safeItems)) return null;
  return buildLabContext(question, safeItems, safePackages);
}
