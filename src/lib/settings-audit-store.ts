import { supabaseAdmin } from "./supabase/admin";

/**
 * บันทึกการแก้ตั้งค่าที่ทำผ่าน server (service role ไม่มีผู้ใช้ trigger จึงไม่บันทึกให้) พร้อมชื่อผู้แก้
 * บันทึกไม่ได้ไม่ทำให้การแก้ล้ม (ตารางอาจยังไม่สร้างก่อนรัน migration 054)
 */
export async function logSettingsAudit(e: {
  actorId: string; section: string; table: string; key: string | null; action: "insert" | "update" | "delete"; oldValue: unknown; newValue: unknown;
}) {
  const db = supabaseAdmin();
  const { data: staff } = await db.from("staff").select("display_name").eq("id", e.actorId).maybeSingle();
  const { error } = await db.from("settings_audit").insert({
    actor_id: e.actorId, actor_name: (staff?.display_name as string | undefined) ?? null, section: e.section, table_name: e.table,
    record_key: e.key, action: e.action, old_value: e.oldValue ?? null, new_value: e.newValue ?? null,
  });
  if (error) console.error("settings audit failed", error.code);
}
