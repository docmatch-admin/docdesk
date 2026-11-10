"use client";

import { useEffect, useState } from "react";
import { usePreferences } from "./preferences";

const toKey = (base64: string) => {
  const raw = atob((base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** สมัคร/ยกเลิกรับแจ้งเตือนบนเครื่องนี้ (ใช้ทั้งเมนูซ้ายและหมวดการแสดงผล) */
export async function setDevicePush(on: boolean, publicKey: string): Promise<boolean> {
  const reg = await navigator.serviceWorker.ready;
  const current = await reg.pushManager.getSubscription();
  if (!on) {
    if (current) {
      await fetch("/api/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: current.endpoint }) });
      await current.unsubscribe();
    }
    return false;
  }
  if (current) return true;
  if ((await Notification.requestPermission()) !== "granted") return false;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
  const res = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
  return res.ok;
}

/**
 * แจ้งเตือนเครื่องนี้: เปิด = เครื่องนี้สมัครแล้ว และผู้ใช้ไม่ได้ปิดแจ้งเตือน (ค่า push_enabled ใช้ร่วมทุกเครื่อง)
 * ปิดที่นี่ = ปิดแจ้งเตือนทุกเครื่องของผู้ใช้คนนี้ (server ไม่ส่ง) · ซ่อนเมื่อเบราว์เซอร์ไม่รองรับ
 */
export function PushToggle() {
  const { prefs, update } = usePreferences();
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const on = subscribed && prefs.push_enabled;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!publicKey || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
    setSupported(true);
    navigator.serviceWorker.register("/sw.js")
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub))
      .catch(() => setSupported(false));
  }, [publicKey]);

  async function toggle() {
    setBusy(true);
    try {
      if (on) { await update({ push_enabled: false }); return; }
      const ok = await setDevicePush(true, publicKey as string);
      setSubscribed(ok);
      if (ok && !prefs.push_enabled) await update({ push_enabled: true });
    } catch (e) {
      console.error("push toggle failed", e);
    } finally {
      setBusy(false);
    }
  }

  if (!supported) return null;
  return (
    <button className="btn ghost small nav-quick" disabled={busy} aria-pressed={on} onClick={toggle} title="ใช้ค่าเดียวกับ ตั้งค่า → การแสดงผล">
      <span aria-hidden="true">📲</span>
      <span>{on ? "แจ้งเตือนเครื่องนี้: เปิด" : "แจ้งเตือนเครื่องนี้: ปิด"}</span>
    </button>
  );
}
