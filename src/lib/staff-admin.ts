import crypto from "node:crypto";
import { supabaseAdmin } from "./supabase/admin";

const BAN_FOREVER = "876000h";
// ไม่มีตัวที่สับสน: 0 O o 1 l I i
const TEMP_PASSWORD_CHARS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateTempPassword(length = 10): string {
  return Array.from({ length }, () => TEMP_PASSWORD_CHARS[crypto.randomInt(TEMP_PASSWORD_CHARS.length)]).join("");
}

/** ปิดหรือเปิดบัญชี คืนข้อความ error ถ้าไม่สำเร็จ */
export async function setStaffActive(id: string, active: boolean, byId: string): Promise<string | null> {
  const db = supabaseAdmin();
  const { error: banError } = await db.auth.admin.updateUserById(id, { ban_duration: active ? "none" : BAN_FOREVER });
  if (banError) return "เปลี่ยนสถานะบัญชีไม่สำเร็จ";
  const { error: updateError } = await db.from("staff").update({ active }).eq("id", id);
  if (updateError) return "เปลี่ยนสถานะบัญชีไม่สำเร็จ";
  if (active) return null;

  await db.rpc("revoke_staff_sessions", { p_user: id });
  const { data: chats } = await db.from("conversations").select("id").eq("assigned_to", id).eq("status", "open");
  for (const chat of (chats ?? []) as { id: string }[]) {
    await db.rpc("set_assignee", { p_conversation: chat.id, p_to: null, p_by: byId });
  }
  return null;
}

/** ออกรหัสชั่วคราวใหม่ คืน null ถ้าไม่สำเร็จ ผู้เรียกต้องไม่เก็บรหัสหรือบันทึกลง log */
export async function resetStaffPassword(id: string): Promise<string | null> {
  const db = supabaseAdmin();
  const password = generateTempPassword();
  const { error: passwordError } = await db.auth.admin.updateUserById(id, { password });
  if (passwordError) return null;
  const { error: flagError } = await db.from("staff").update({ must_change_password: true }).eq("id", id);
  if (flagError) return null;
  await db.rpc("revoke_staff_sessions", { p_user: id });
  return password;
}
