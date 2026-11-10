/**
 * สิทธิ์หน้าตั้งค่าตาม role (หน้าเว็บใช้ซ่อน/ล็อก · ฐานข้อมูลบังคับจริงด้วย RLS ใน migration 054 และ API ใช้ requireAdmin)
 * edit = แก้ได้ · view = เห็นแบบอ่านอย่างเดียว (กุญแจ "เฉพาะ admin") · ไม่อยู่ในรายการ = ไม่เห็นเลย
 */
import type { StaffRole } from "./auth-types";

export type SettingsSection = "overview" | "ai" | "chat" | "appointments" | "team" | "display";

export type SettingsArea =
  // ภาพรวม
  | "health" | "lineQuota" | "aiUsage" | "priceAlerts"
  // AI
  | "aiModels" | "aiMode" | "channels" | "persona"
  // แชทและแท็ก
  | "businessHours" | "autoClose" | "tags" | "tagRules" | "sensitive"
  // นัดหมาย
  | "apptContact" | "apptMessaging" | "apptTemplate" | "purposes" | "providers" | "clinicHours" | "closures" | "seriesTemplates" | "bookingTemplates" | "testSend"
  // ทีมและระบบ
  | "scoring" | "retention" | "dataRetention" | "audit"
  // การแสดงผล (ส่วนตัว)
  | "display";

export type Access = "edit" | "view";

const AGENT: Partial<Record<SettingsArea, Access>> = {
  // แก้ได้
  purposes: "edit", closures: "edit", seriesTemplates: "edit", providers: "edit", tags: "edit", tagRules: "edit", display: "edit",
  // เห็นแต่แก้ไม่ได้
  apptContact: "view", apptMessaging: "view", apptTemplate: "view", bookingTemplates: "view",
  clinicHours: "view", businessHours: "view", autoClose: "view", lineQuota: "view", health: "view",
};

export function areaAccess(role: StaffRole | null | undefined, area: SettingsArea): Access | null {
  if (role === "admin") return "edit";
  if (role === "agent") return AGENT[area] ?? null;
  return null;
}

/** หมวดย่อยและส่วนในหมวด */
export const SECTION_AREAS: Record<SettingsSection, SettingsArea[]> = {
  overview: ["health", "lineQuota", "aiUsage", "priceAlerts"],
  ai: ["aiModels", "aiMode", "channels", "persona"],
  chat: ["businessHours", "autoClose", "tags", "tagRules", "sensitive"],
  appointments: ["apptContact", "apptMessaging", "apptTemplate", "purposes", "providers", "clinicHours", "closures", "seriesTemplates", "bookingTemplates", "testSend"],
  team: ["scoring", "retention", "dataRetention", "audit"],
  display: ["display"],
};

/** หมวดที่ role นี้เห็นอย่างน้อยหนึ่งส่วน */
export function visibleSections(role: StaffRole | null | undefined): SettingsSection[] {
  return (Object.keys(SECTION_AREAS) as SettingsSection[]).filter((s) => SECTION_AREAS[s].some((a) => areaAccess(role, a)));
}

/** เปิดหน้าตั้งค่าได้ไหม (ห้องยาไม่มีหน้าตั้งค่า) */
export const canOpenSettings = (role: StaffRole | null | undefined) => role === "admin" || role === "agent";

