import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { canOpenSettings } from "@/lib/settings-access";
import { SettingsClient } from "./settings-client";

/** admin แก้ได้ทุกอย่าง · agent เห็นบางหมวด (สิทธิ์จริงบังคับที่ฐานข้อมูลและ API) · ห้องยาไม่มีหน้าตั้งค่า */
export default async function SettingsPage() {
  const me = await getStaffContext();
  if (!me || !canOpenSettings(me.role)) redirect(me?.role === "pharmacy" ? "/appointments" : "/inbox");
  return <SettingsClient role={me.role} />;
}
