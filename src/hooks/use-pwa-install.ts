"use client";

import { useCallback, useSyncExternalStore } from "react";
import { detectInstallPlatform, INSTALLED_FLAG_KEY, type InstallPlatform } from "@/lib/pwa-install";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface PwaInstallState {
  /** เบราว์เซอร์ให้เปิดหน้าต่างติดตั้งได้ (Chrome/Edge บน Android/คอม) */
  canPrompt: boolean;
  isIOS: boolean;
  isInstalled: boolean;
  /** อ่านค่าจากเบราว์เซอร์แล้ว (ตอน render ฝั่ง server ยังเป็น false ทั้งหมด) */
  ready: boolean;
  platform: InstallPlatform;
}

const SERVER_PLATFORM: InstallPlatform = { isIOS: false, isIPad: false, isAndroid: false, isIOSSafari: false, inApp: null };
const SERVER_SNAP: PwaInstallState = { canPrompt: false, isIOS: false, isInstalled: false, ready: false, platform: SERVER_PLATFORM };

// เก็บไว้ระดับ module (ไม่ใช่ใน component): event beforeinstallprompt มาครั้งเดียว และอาจมาก่อน component mount
// แบนเนอร์กับปุ่มในเมนูจึงใช้ event ตัวเดียวกัน — กดที่ไหนก็ใช้หมดทั้งคู่
let deferred: BeforeInstallPromptEvent | null = null;
let snap: PwaInstallState = SERVER_SNAP;
const listeners = new Set<() => void>();

const readFlag = () => { try { return localStorage.getItem(INSTALLED_FLAG_KEY) === "1"; } catch { return false; } };
const writeFlag = (on: boolean) => {
  try { if (on) localStorage.setItem(INSTALLED_FLAG_KEY, "1"); else localStorage.removeItem(INSTALLED_FLAG_KEY); } catch { /* private mode */ }
};

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: window-controls-overlay)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function update(patch: Partial<PwaInstallState>) {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

let started = false;
function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  const platform = detectInstallPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  snap = { canPrompt: false, isIOS: platform.isIOS, isInstalled: isStandalone() || readFlag(), ready: true, platform };
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    // เบราว์เซอร์ขอติดตั้งอีก = ยังไม่ได้ติดตั้ง (หรือถอนไปแล้ว)
    writeFlag(false);
    update({ canPrompt: true, isInstalled: isStandalone() });
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    writeFlag(true);
    update({ canPrompt: false, isInstalled: true });
  });
  window.matchMedia("(display-mode: standalone)").addEventListener?.("change", (e) => { if (e.matches) update({ isInstalled: true }); });
}
// เริ่มฟังทันทีที่โหลดไฟล์นี้ ไม่รอ useEffect
start();

function subscribe(l: () => void) {
  start();
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** สถานะติดตั้งแอป + ฟังก์ชันเปิดหน้าต่างติดตั้งของเบราว์เซอร์ */
export function usePwaInstall() {
  const state = useSyncExternalStore(subscribe, () => snap, () => SERVER_SNAP);
  const promptInstall = useCallback(async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
    const e = deferred;
    if (!e) return "unavailable";
    deferred = null; // ใช้ได้ครั้งเดียว
    update({ canPrompt: false });
    await e.prompt();
    const { outcome } = await e.userChoice;
    if (outcome === "accepted") { writeFlag(true); update({ isInstalled: true }); }
    return outcome;
  }, []);
  return { ...state, promptInstall };
}
