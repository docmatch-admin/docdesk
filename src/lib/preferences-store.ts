import { supabaseAdmin } from "./supabase/admin";
import { DEFAULT_PREFERENCES, normalizePreferences, type Preferences } from "./theme";

const COLUMNS = "theme, sound_muted, push_enabled, nav_collapsed, font_size";

/** ตั้งค่าส่วนตัวของผู้ใช้ ยังไม่เคยตั้ง/ตารางยังไม่มี = ค่าเริ่มต้น */
export async function loadPreferences(userId: string): Promise<Preferences> {
  const { data, error } = await supabaseAdmin().from("user_preferences").select(COLUMNS).eq("user_id", userId).maybeSingle();
  if (error || !data) return { ...DEFAULT_PREFERENCES };
  return normalizePreferences(data);
}

/** แก้บางค่า (ค่าอื่นคงเดิม) คืนค่าทั้งหมดหลังบันทึก */
export async function savePreferences(userId: string, patch: Partial<Record<keyof Preferences, unknown>>): Promise<Preferences> {
  const next = normalizePreferences({ ...(await loadPreferences(userId)), ...patch });
  const { error } = await supabaseAdmin().from("user_preferences").upsert({ user_id: userId, ...next, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw error;
  return next;
}

/** ผู้ใช้ที่ปิดแจ้งเตือน (ทุกเครื่อง) ไม่ส่ง push ให้ */
export async function pushDisabledStaff(): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin().from("user_preferences").select("user_id").eq("push_enabled", false);
  if (error) return new Set();
  return new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id));
}
