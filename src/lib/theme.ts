/**
 * ตั้งค่าส่วนตัวต่อผู้ใช้ (หมวด "การแสดงผล"): เก็บในตาราง user_preferences sync ทุกเครื่องของคนนั้น
 * ค่าที่ต้องรู้ก่อนวาดหน้า (ธีม ขนาดตัวอักษร ย่อเมนู) เก็บซ้ำใน cookie ให้ server ใส่ที่ <html> ตั้งแต่แรก ไม่มีจอกะพริบ
 */
export type ThemeChoice = "system" | "light" | "dark";
export type FontSize = "normal" | "large";
export const THEME_LABEL: Record<ThemeChoice, string> = { system: "ตามระบบ", light: "สว่าง", dark: "มืด" };
export const FONT_LABEL: Record<FontSize, string> = { normal: "ปกติ", large: "ใหญ่" };

export interface Preferences {
  theme: ThemeChoice;
  sound_muted: boolean;
  push_enabled: boolean;
  nav_collapsed: boolean;
  font_size: FontSize;
}
export const DEFAULT_PREFERENCES: Preferences = { theme: "system", sound_muted: false, push_enabled: true, nav_collapsed: false, font_size: "normal" };

export function normalizeTheme(v: unknown): ThemeChoice {
  return v === "light" || v === "dark" ? v : "system";
}

export function normalizePreferences(v: unknown): Preferences {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    theme: normalizeTheme(o.theme),
    sound_muted: o.sound_muted === true,
    push_enabled: o.push_enabled !== false,
    nav_collapsed: o.nav_collapsed === true,
    font_size: o.font_size === "large" ? "large" : "normal",
  };
}

/** cookie ที่ server อ่านตอนวาด <html> (ไม่ใช่ข้อมูลลับ อ่านได้ฝั่ง client) */
export const PREF_COOKIE = { theme: "dd_theme", font: "dd_font", nav: "dd_nav" } as const;
const YEAR = 60 * 60 * 24 * 365;

/** แอตทริบิวต์บน <html> จากค่าใน cookie */
export function htmlAttrs(get: (name: string) => string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  const theme = normalizeTheme(get(PREF_COOKIE.theme));
  if (theme !== "system") attrs["data-theme"] = theme;
  if (get(PREF_COOKIE.font) === "large") attrs["data-font"] = "large";
  if (get(PREF_COOKIE.nav) === "collapsed") attrs["data-nav"] = "collapsed";
  return attrs;
}

/** ใช้ค่ากับหน้าที่เปิดอยู่ทันที (ไม่ต้องรีโหลด) และจำใน cookie สำหรับการโหลดครั้งถัดไป */
export function applyPreferences(p: Preferences, doc: Document = document) {
  const root = doc.documentElement;
  if (p.theme === "system") delete root.dataset.theme; else root.dataset.theme = p.theme;
  if (p.font_size === "large") root.dataset.font = "large"; else delete root.dataset.font;
  if (p.nav_collapsed) root.dataset.nav = "collapsed"; else delete root.dataset.nav;
  const set = (k: string, v: string) => { doc.cookie = `${k}=${v}; path=/; max-age=${YEAR}; samesite=lax`; };
  set(PREF_COOKIE.theme, p.theme);
  set(PREF_COOKIE.font, p.font_size);
  set(PREF_COOKIE.nav, p.nav_collapsed ? "collapsed" : "open");
}

/** ธีมที่เห็นจริงตอนนี้ (ตามระบบ = ดูจากเครื่อง) */
export function effectiveTheme(choice: ThemeChoice, systemDark: boolean): "light" | "dark" {
  return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}
