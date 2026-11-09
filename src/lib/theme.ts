/**
 * ธีมสว่าง/มืด: ค่าเริ่มต้นตามการตั้งค่าของเครื่อง (prefers-color-scheme)
 * เลือกเองได้ที่ ตั้งค่า → การแสดงผล · จำต่อเครื่อง (localStorage) ไม่ส่งขึ้นเซิร์ฟเวอร์
 */
export type ThemeChoice = "system" | "light" | "dark";
export const THEME_KEY = "docdesk-theme";
export const THEME_LABEL: Record<ThemeChoice, string> = { system: "ตามเครื่อง", light: "สว่าง", dark: "มืด" };

export function normalizeTheme(v: unknown): ThemeChoice {
  return v === "light" || v === "dark" ? v : "system";
}

/** ใส่/เอา data-theme ที่ <html> · "system" = ไม่ใส่ ให้ CSS ตาม prefers-color-scheme */
export function applyTheme(choice: ThemeChoice, root: { dataset: DOMStringMap } = document.documentElement) {
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
}

/** สคริปต์ที่รันก่อนวาดหน้า (ใน <head>) กันหน้าจอกะพริบสีขาวตอนเปิดในโหมดมืด */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
