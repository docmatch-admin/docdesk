"use client";

import { useEffect, useState } from "react";

const toKey = (base64: string) => {
  const raw = atob((base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** เปิดรับแจ้งเตือนนัดบนเครื่องนี้ ซ่อนเมื่อเบราว์เซอร์ไม่รองรับ เช่น iPhone ที่ยังไม่ได้เพิ่มลงหน้าจอหลัก */
export function PushToggle() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!publicKey || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
    setSupported(true);
    navigator.serviceWorker.register("/sw.js")
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setOn(!!sub))
      .catch(() => setSupported(false));
  }, [publicKey]);

  async function toggle() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const current = await reg.pushManager.getSubscription();
      if (current) {
        await fetch("/api/push", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: current.endpoint }) });
        await current.unsubscribe();
        setOn(false);
        return;
      }
      if ((await Notification.requestPermission()) !== "granted") return;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey as string) });
      const res = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
      setOn(res.ok);
    } catch (e) {
      console.error("push toggle failed", e);
    } finally {
      setBusy(false);
    }
  }

  if (!supported) return null;
  return (
    <button className="btn ghost small" disabled={busy} aria-pressed={on} onClick={toggle}>
      {on ? "📲 แจ้งเตือนเครื่องนี้: เปิด" : "📲 แจ้งเตือนเครื่องนี้: ปิด"}
    </button>
  );
}
