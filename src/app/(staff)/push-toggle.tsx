"use client";

import { useState } from "react";
import { deniedHelp } from "@/lib/push-rules";
import { useInstallFlow } from "./install-app";
import { usePreferences } from "./preferences";
import { usePushDevice } from "./push-control";
import { Icon } from "./icons";

/**
 * แจ้งเตือนเครื่องนี้ (เมนูซ้าย): เปิด = เครื่องนี้สมัครแล้ว และผู้ใช้ไม่ได้ปิดแจ้งเตือน (ค่า push_enabled ใช้ร่วมทุกเครื่อง)
 * ปิดที่นี่ = ปิดแจ้งเตือนทุกเครื่องของผู้ใช้คนนี้ (server ไม่ส่ง) · ขอสิทธิ์เฉพาะตอนกดปุ่ม
 * iPhone ที่ยังไม่ติดตั้งลงหน้าจอโฮม: ปุ่มจาง กดแล้วเปิดวิธีติดตั้ง
 */
export function PushToggle({ row }: { row?: boolean } = {}) {
  const { prefs, update } = usePreferences();
  const push = usePushDevice();
  const { openSheet, sheetEl } = useInstallFlow();
  const subscribed = push.subscribed;
  const on = subscribed && prefs.push_enabled;
  const [busy, setBusy] = useState(false);

  if (push.state === "loading" || push.state === "unsupported") return null;

  async function toggle() {
    if (push.state === "ios-install-first") { openSheet("ios-steps"); return; }
    if (push.state === "denied") return;
    setBusy(true);
    try {
      if (on) { await update({ push_enabled: false }); return; }
      await push.enable();
    } finally {
      setBusy(false);
    }
  }

  const faded = push.state === "ios-install-first" || push.state === "denied";
  const label = push.state === "ios-install-first" ? "แจ้งเตือน: ต้องติดตั้งลงหน้าจอก่อน"
    : push.state === "denied" ? "แจ้งเตือน: ถูกปิดที่เครื่อง"
    : on ? "แจ้งเตือน: เปิด" : "แจ้งเตือน: ปิด";
  if (row) {
    const hint = push.state === "ios-install-first" ? "ต้องติดตั้งลงหน้าจอก่อน" : push.state === "denied" ? "ถูกปิดที่เครื่อง" : null;
    return (
      <>
        <button type="button" role="switch" aria-checked={on} className={`m-row m-switch-row${faded ? " push-faded" : ""}`} disabled={busy} onClick={toggle}
          title={push.state === "denied" ? deniedHelp(push.platform) : undefined}>
          <Icon name="bell" size={22} />
          <span className="m-row-label">แจ้งเตือน{hint && <small className="muted"> · {hint}</small>}</span>
          <span className="m-switch" aria-hidden="true" />
        </button>
        {sheetEl}
      </>
    );
  }
  return (
    <>
      <button className={`btn ghost small nav-quick${faded ? " push-faded" : ""}`} disabled={busy} aria-pressed={on} onClick={toggle}
        title={push.state === "denied" ? deniedHelp(push.platform) : "ใช้ค่าเดียวกับ ตั้งค่า → การแสดงผล"}>
        <Icon name={on ? "bell" : "bellOff"} size={16} />
        <span>{label}</span>
      </button>
      {sheetEl}
    </>
  );
}
