"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { usePwaInstall } from "@/hooks/use-pwa-install";
import { BADGE_EVENT, deniedHelp, PUSH_SNOOZE_KEY, pushUiState, type PushUiState } from "@/lib/push-rules";
import { isSnoozed, snoozeUntil } from "@/lib/pwa-install";
import { SW_SCOPE, SW_URL } from "@/lib/sw-url";
import { Icon } from "./icons";
import { useInstallBanner, useInstallFlow } from "./install-app";
import { usePreferences } from "./preferences";

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

const toKey = (base64: string) => {
  const raw = atob((base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/* ---------- สถานะเครื่องนี้ (ใช้ร่วมกันทุกปุ่ม: แบนเนอร์ เมนูซ้าย หน้าตั้งค่า) ---------- */

interface DeviceState { ready: boolean; supported: boolean; permission: NotificationPermission | null; endpoint: string | null }
let device: DeviceState = { ready: false, supported: false, permission: null, endpoint: null };
const SERVER_DEVICE = device;
const listeners = new Set<() => void>();
const setDevice = (patch: Partial<DeviceState>) => { device = { ...device, ...patch }; listeners.forEach((l) => l()); };

const pushSupported = () => !!PUBLIC_KEY && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration() {
  await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  return navigator.serviceWorker.ready;
}

async function saveSubscription(sub: PushSubscription) {
  const res = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
  return res.ok;
}

let probing: Promise<void> | null = null;
function probe() {
  if (probing) return probing;
  probing = (async () => {
    if (!pushSupported()) { setDevice({ ready: true, supported: false }); return; }
    try {
      const reg = await registration();
      const sub = await reg.pushManager.getSubscription();
      setDevice({ ready: true, supported: true, permission: Notification.permission, endpoint: sub?.endpoint ?? null });
    } catch {
      setDevice({ ready: true, supported: false });
    }
  })();
  return probing;
}

/** สมัครรับแจ้งเตือน — ต้องเรียกจากการกดปุ่มเท่านั้น (requestPermission ก่อน await อื่น เพื่อให้ iPhone นับว่าผู้ใช้กดเอง) */
async function subscribeFromClick(): Promise<{ ok: boolean; error?: string }> {
  const permission = await Notification.requestPermission();
  setDevice({ permission });
  if (permission !== "granted") return { ok: false };
  try {
    const reg = await registration();
    const sub = (await reg.pushManager.getSubscription())
      ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(PUBLIC_KEY) });
    const ok = await saveSubscription(sub);
    setDevice({ endpoint: sub.endpoint });
    return ok ? { ok } : { ok, error: "บันทึกเครื่องนี้ไม่สำเร็จ ลองใหม่อีกครั้ง" };
  } catch (e) {
    console.error("push subscribe failed", e);
    return { ok: false, error: "เปิดแจ้งเตือนไม่สำเร็จ ลองใหม่อีกครั้ง" };
  }
}

async function unsubscribeDevice() {
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await fetch("/api/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    await sub.unsubscribe();
  }
  setDevice({ endpoint: null });
}

/** สถานะแจ้งเตือนของเครื่องนี้ + คำสั่ง */
export function usePushDevice() {
  const d = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => device, () => SERVER_DEVICE);
  const pwa = usePwaInstall();
  const { prefs, update } = usePreferences();
  useEffect(() => { probe(); }, []);
  const subscribed = !!d.endpoint;
  const state: PushUiState = pushUiState({
    ready: d.ready && pwa.ready, isIOS: pwa.isIOS, isInstalled: pwa.isInstalled, supported: d.supported,
    permission: d.permission, subscribed, enabled: prefs.push_enabled,
  });

  const enable = useCallback(async () => {
    const r = await subscribeFromClick();
    if (r.ok && !prefs.push_enabled) await update({ push_enabled: true });
    return r;
  }, [prefs.push_enabled, update]);

  const test = useCallback(async (): Promise<string> => {
    if (!d.endpoint) return "เครื่องนี้ยังไม่ได้เปิดแจ้งเตือน";
    const res = await fetch("/api/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: d.endpoint }) });
    if (res.ok) return "ส่งแล้ว รอแจ้งเตือนสักครู่";
    const j = await res.json().catch(() => ({}));
    return (j as { error?: string }).error ?? "ส่งไม่สำเร็จ";
  }, [d.endpoint]);

  return { state, permission: d.permission, subscribed, enabled: prefs.push_enabled, platform: pwa.platform, enable, test, disableDevice: unsubscribeDevice, setEnabled: (v: boolean) => update({ push_enabled: v }) };
}

/* ---------- เปิดแอปทุกครั้ง: subscription หาย → สมัครใหม่ · ตัวเลขบนไอคอนแอป ---------- */

/** วางไว้ใน layout ครั้งเดียว ไม่แสดงผล · ไม่ขอสิทธิ์เอง (ขอเฉพาะเมื่อกดปุ่ม) */
export function PushKeeper() {
  const { prefs } = usePreferences();
  useEffect(() => {
    if (!prefs.push_enabled || !pushSupported() || Notification.permission !== "granted") return;
    (async () => {
      try {
        const reg = await registration();
        // ได้สิทธิ์แล้วแต่ subscription หาย (ล้างข้อมูล/เบราว์เซอร์หมุน key): สมัครใหม่ได้โดยไม่ต้องถาม
        const sub = (await reg.pushManager.getSubscription())
          ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(PUBLIC_KEY) });
        await saveSubscription(sub);
        setDevice({ ready: true, supported: true, permission: "granted", endpoint: sub.endpoint });
      } catch (e) {
        console.error("push resubscribe failed", e);
      }
    })();
  }, [prefs.push_enabled]);

  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!nav.setAppBadge) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const sync = () => {
      if (document.visibilityState !== "visible") return;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        fetch("/api/push/badge").then((r) => (r.ok ? r.json() : null)).then((j: { count?: number } | null) => {
          if (!j || typeof j.count !== "number") return;
          (j.count > 0 ? nav.setAppBadge!(j.count) : nav.clearAppBadge?.())?.catch(() => {});
        }).catch(() => {});
      }, 800);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener(BADGE_EVENT, sync);
    const poll = setInterval(sync, 2 * 60_000);
    return () => { document.removeEventListener("visibilitychange", sync); window.removeEventListener(BADGE_EVENT, sync); clearInterval(poll); if (t) clearTimeout(t); };
  }, []);
  return null;
}


/* ---------- ปุ่ม/ข้อความตามสถานะ (หน้าตั้งค่า) ---------- */

export function PushSettingsControl() {
  const push = usePushDevice();
  const { openSheet, sheetEl } = useInstallFlow();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setMsg("");
    try { await fn(); } finally { setBusy(false); }
  }

  let body: React.ReactNode;
  switch (push.state) {
    case "loading":
      body = <span className="muted">กำลังตรวจ…</span>;
      break;
    case "ios-install-first":
      body = (
        <span className="push-control">
          <button type="button" className="btn ghost small push-faded" onClick={() => openSheet("ios-steps")}>
            <Icon name="bell" size={16} /> เปิดแจ้งเตือนแชทใหม่
          </button>
          <span className="muted small">ต้องติดตั้งลงหน้าจอก่อน — iPhone รับแจ้งเตือนได้เฉพาะเมื่อเปิด DocDesk จากไอคอนบนหน้าจอโฮม</span>
          <button type="button" className="btn ghost small" onClick={() => openSheet("ios-steps")}>ดูวิธีติดตั้ง</button>
        </span>
      );
      break;
    case "unsupported":
      body = <span className="muted">เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน ลองใช้ Chrome หรือ Edge</span>;
      break;
    case "denied":
      body = (
        <span className="push-control">
          <span><Icon name="bellOff" size={16} /> ปิดการแจ้งเตือนไว้ที่เครื่อง</span>
          <span className="muted small">{deniedHelp(push.platform)}</span>
        </span>
      );
      break;
    case "on":
      body = (
        <span className="push-control">
          <span className="push-on">แจ้งเตือนเปิดอยู่ ✓</span>
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => run(async () => setMsg(await push.test()))}>ทดสอบแจ้งเตือน</button>
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => run(push.disableDevice)}>ปิดเครื่องนี้</button>
        </span>
      );
      break;
    default:
      body = (
        <button type="button" className="btn primary small" disabled={busy}
          onClick={() => run(async () => { const r = await push.enable(); if (r.error) setMsg(r.error); })}>
          <Icon name="bell" size={16} /> เปิดแจ้งเตือนแชทใหม่
        </button>
      );
  }
  return (
    <>
      {body}
      {msg && <span className="small muted" role="status">{msg}</span>}
      {sheetEl}
    </>
  );
}

/* ---------- แบนเนอร์ด้านบนครั้งแรกหลังล็อกอิน ---------- */

function usePushBanner() {
  const push = usePushDevice();
  const [snoozed, setSnoozed] = useState(true);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    try { setSnoozed(isSnoozed(localStorage.getItem(PUSH_SNOOZE_KEY), Date.now())); } catch { setSnoozed(false); }
  }, []);
  function later() {
    setSnoozed(true);
    try { localStorage.setItem(PUSH_SNOOZE_KEY, snoozeUntil(Date.now())); } catch { /* private mode: ซ่อนแค่รอบนี้ */ }
  }
  // ขึ้นเฉพาะตอนกดแล้วเปิดได้จริง (iPhone ที่ยังไม่ติดตั้ง → แบนเนอร์ติดตั้งขึ้นแทน)
  // ยังไม่เคยถาม (ไม่ใช่คนที่ปิดเองในตั้งค่า หรือเคยกดไม่อนุญาต)
  const show = push.state === "off" && push.permission === "default" && !snoozed;
  const element = show && (
    <div className="install-banner" role="region" aria-label="เปิดแจ้งเตือน">
      <span className="install-banner-icon" aria-hidden="true"><Icon name="bell" size={18} /></span>
      <span className="install-banner-text">{msg || "เปิดแจ้งเตือนแชทใหม่ ไม่พลาดข้อความลูกค้าแม้ปิดแอปอยู่"}</span>
      <span className="install-banner-actions">
        <button type="button" className="btn primary small" onClick={async () => { const r = await push.enable(); if (r.error) setMsg(r.error); }}>เปิดแจ้งเตือน</button>
        <button type="button" className="btn ghost small" onClick={later}>ไว้ทีหลัง</button>
      </span>
    </div>
  );
  return { show, element };
}

/** แบนเนอร์บนสุด: ติดตั้งแอปก่อน แล้วค่อยชวนเปิดแจ้งเตือน (ไม่ซ้อนสองแถบ) */
export function StaffBanners() {
  const install = useInstallBanner();
  const push = usePushBanner();
  return <>{install.show ? install.element : push.element}{install.sheetEl}</>;
}
