// กฎของปุ่ม "ติดตั้ง DocDesk" (PWA) — ฟังก์ชันล้วน ไม่แตะ window เพื่อทดสอบใน node ได้ (scripts/pwa.test.mjs)

/** ซ่อนแบนเนอร์หลังกด "ไว้ทีหลัง" */
export const INSTALL_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
export const INSTALL_SNOOZE_KEY = "docdesk.install.snoozeUntil";
/** จำว่าเบราว์เซอร์นี้เคยติดตั้งแล้ว (เปิดจากแท็บเบราว์เซอร์ก็ยังขึ้น "ติดตั้งแล้ว ✓") · ล้างเมื่อเบราว์เซอร์ขอติดตั้งอีกครั้ง (ถอนแอปไปแล้ว) */
export const INSTALLED_FLAG_KEY = "docdesk.install.installed";

export type InAppBrowser = "line" | "facebook" | "instagram" | "other";

export interface InstallPlatform {
  /** iPhone / iPad / iPod รวม iPadOS ที่รายงานตัวเป็น Mac + จอสัมผัส */
  isIOS: boolean;
  isIPad: boolean;
  isAndroid: boolean;
  /** Safari ตัวจริงบน iOS (ติดตั้งผ่าน "เพิ่มไปยังหน้าจอโฮม" ได้) */
  isIOSSafari: boolean;
  /** เปิดจากในแอปอื่น (LINE / Facebook / Instagram / webview) หรือเบราว์เซอร์อื่นบน iOS — ติดตั้งไม่ได้ ต้องเปิดใน Safari/Chrome */
  inApp: InAppBrowser | null;
}

const IN_APP: [InAppBrowser, RegExp][] = [
  ["line", /\bLine\//i],
  ["facebook", /FBAN|FBAV|FB_IAB|FBIOS|MessengerForiOS|\bMessenger\b/i],
  ["instagram", /Instagram/i],
];
// เบราว์เซอร์อื่นบน iOS (ไม่ใช่ Safari) — ใช้ WebKit เหมือนกันแต่ให้ทุกคนทำขั้นตอนเดียวกันใน Safari
const IOS_OTHER_BROWSER = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|YaBrowser|DuckDuckGo|Brave|Focus\//i;

export function detectInstallPlatform(ua: string, platform = "", maxTouchPoints = 0): InstallPlatform {
  const iPadOS = maxTouchPoints > 1 && (/Macintosh/i.test(ua) || platform === "MacIntel");
  const isIPad = /iPad/i.test(ua) || iPadOS;
  const isIOS = isIPad || /iPhone|iPod/i.test(ua);
  const isAndroid = !isIOS && /Android/i.test(ua);
  let inApp: InAppBrowser | null = IN_APP.find(([, re]) => re.test(ua))?.[0] ?? null;
  if (!inApp && isAndroid && /;\s*wv\)/.test(ua)) inApp = "other";
  // webview บน iOS ไม่มีคำว่า "Safari/" ใน UA (Safari จริงมีเสมอ)
  if (!inApp && isIOS && (IOS_OTHER_BROWSER.test(ua) || !/Safari\//.test(ua))) inApp = "other";
  return { isIOS, isIPad, isAndroid, isIOSSafari: isIOS && !inApp, inApp };
}

/** ยังอยู่ในช่วง "ไว้ทีหลัง" หรือไม่ (ค่าเสีย/ว่าง = ไม่ซ่อน) */
export function isSnoozed(raw: string | null, now: number): boolean {
  const until = Number(raw);
  return Number.isFinite(until) && until > now;
}

export function snoozeUntil(now: number): string {
  return String(now + INSTALL_SNOOZE_MS);
}

/** ลิงก์สำหรับเปิดนอกแอป: LINE รองรับ ?openExternalBrowser=1 · Android ใช้ intent:// เปิด Chrome · อื่นๆ ใช้คัดลอกลิงก์ */
export function externalOpenUrl(href: string, p: InstallPlatform): string | null {
  const u = new URL(href);
  if (p.inApp === "line") {
    u.searchParams.set("openExternalBrowser", "1");
    return u.toString();
  }
  if (p.isAndroid) return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;end`;
  return null;
}

export type InstallAction = "installed" | "open-external" | "ios-steps" | "prompt" | "manual";

/** กดปุ่มติดตั้งแล้วทำอะไร */
export function installAction(s: { isInstalled: boolean; canPrompt: boolean; platform: InstallPlatform }): InstallAction {
  if (s.isInstalled) return "installed";
  if (s.platform.inApp) return "open-external";
  if (s.platform.isIOS) return "ios-steps";
  if (s.canPrompt) return "prompt";
  return "manual";
}

/** แบนเนอร์ด้านบน: ขึ้นเฉพาะเมื่อกดแล้วทำอะไรได้จริง (ไม่ขึ้นบนเบราว์เซอร์ที่ติดตั้งไม่ได้ เช่น Firefox บนคอม) */
export function showInstallBanner(s: { isInstalled: boolean; canPrompt: boolean; platform: InstallPlatform; snoozed: boolean }): boolean {
  if (s.isInstalled || s.snoozed) return false;
  return s.canPrompt || s.platform.isIOS || s.platform.inApp !== null;
}
