"use client";

import { useEffect, useState } from "react";
import { DEFAULT_PREFERENCES, FONT_LABEL, THEME_LABEL, type FontSize, type Preferences, type ThemeChoice } from "@/lib/theme";
import { usePreferencesOptional } from "../preferences";
import { setDevicePush } from "../push-toggle";
import { SetGroup, SetLine, Switch } from "./settings-save";

const THEMES: ThemeChoice[] = ["system", "light", "dark"];
const FONTS: FontSize[] = ["normal", "large"];

/**
 * การแสดงผล (ตั้งค่าส่วนตัวต่อผู้ใช้ ทุก role): เก็บในฐานข้อมูล sync ทุกเครื่องของคนนั้น
 * มีผลทันที ไม่ต้องกดบันทึกการตั้งค่า · ปุ่มในเมนูซ้ายใช้ค่าเดียวกัน
 */
export function DisplaySettings({ initial }: { initial?: Preferences } = {}) {
  const ctx = usePreferencesOptional();
  // นอก provider (ภาพตัวอย่าง) ใช้ค่าในหน้านี้
  const [local, setLocal] = useState<Preferences>(initial ?? DEFAULT_PREFERENCES);
  const prefs = ctx?.prefs ?? local;
  const [err, setErr] = useState("");
  const update = async (patch: Partial<Preferences>) => {
    if (!ctx) return setLocal((p) => ({ ...p, ...patch }));
    setErr((await ctx.update(patch)) ?? "");
  };

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const [device, setDevice] = useState<"unsupported" | "on" | "off">("unsupported");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!publicKey || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    navigator.serviceWorker.register("/sw.js").then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setDevice(sub ? "on" : "off")).catch(() => setDevice("unsupported"));
  }, [publicKey]);

  async function toggleDevice() {
    if (!publicKey) return;
    setBusy(true);
    try { setDevice((await setDevicePush(device !== "on", publicKey)) ? "on" : "off"); } finally { setBusy(false); }
  }

  return (
    <>
      <SetGroup title="ธีมและตัวอักษร" info="ตั้งค่าส่วนตัวของคุณ ใช้ทุกเครื่องที่ล็อกอินบัญชีนี้ · มีผลทันที ไม่ต้องกดบันทึก">
        <SetLine label="ธีมสี" desc={`ตามระบบ = ตามการตั้งค่าของคอมหรือมือถือ (ตอนนี้เครื่องตั้งเป็น${ctx?.systemDark ? "มืด" : "สว่าง"}) · ใบนัดที่พิมพ์เป็นขาวดำเสมอ`}>
          <div className="theme-choice" role="radiogroup" aria-label="ธีมสี">
            {THEMES.map((t) => (
              <button key={t} type="button" role="radio" aria-checked={prefs.theme === t} onClick={() => update({ theme: t })}>{THEME_LABEL[t]}</button>
            ))}
          </div>
        </SetLine>
        <SetLine label="ขนาดตัวอักษร" desc="ใหญ่ = ขยายทั้งแอปประมาณ 12%">
          <div className="theme-choice" role="radiogroup" aria-label="ขนาดตัวอักษร">
            {FONTS.map((f) => (
              <button key={f} type="button" role="radio" aria-checked={prefs.font_size === f} onClick={() => update({ font_size: f })}>{FONT_LABEL[f]}</button>
            ))}
          </div>
        </SetLine>
        <SetLine label="ย่อเมนูเป็นค่าเริ่มต้น" desc="เมนูซ้ายแสดงเฉพาะไอคอน (ปุ่มย่อเมนูใช้ค่าเดียวกัน)">
          <Switch checked={prefs.nav_collapsed} onChange={(v) => update({ nav_collapsed: v })} label={prefs.nav_collapsed ? "ย่อ" : "ไม่ย่อ"} />
        </SetLine>
      </SetGroup>

      <SetGroup title="การแจ้งเตือน" info="ปิดที่เครื่องไหน ทุกเครื่องของบัญชีนี้ปิดตาม">
        <SetLine label="เสียงเตือน" desc="แชทรอตอบและนัดที่ยังไม่ลงระบบ · ปุ่มเสียงในเมนูซ้ายใช้ค่าเดียวกัน">
          <Switch checked={!prefs.sound_muted} onChange={(v) => update({ sound_muted: !v })} label={prefs.sound_muted ? "ปิด" : "เปิด"} />
        </SetLine>
        <SetLine label="แจ้งเตือน (push)" desc="ปิด = ไม่ส่งแจ้งเตือนไปทุกเครื่องของคุณ">
          <Switch checked={prefs.push_enabled} onChange={(v) => update({ push_enabled: v })} label={prefs.push_enabled ? "เปิด" : "ปิด"} />
        </SetLine>
        <SetLine label="แจ้งเตือนเครื่องนี้" desc={device === "unsupported" ? "เบราว์เซอร์นี้ไม่รองรับ (iPhone ต้องเพิ่มลงหน้าจอหลักก่อน)" : "สมัครรับแจ้งเตือนบนเครื่อง/เบราว์เซอร์ที่ใช้อยู่"}>
          {device === "unsupported" ? <span className="muted">ไม่รองรับ</span> : (
            <span className="inline-field">
              <span>{device === "on" ? "สมัครแล้ว" : "ยังไม่สมัคร"}</span>
              <button type="button" className="btn ghost small" disabled={busy} onClick={toggleDevice}>{device === "on" ? "ยกเลิกเครื่องนี้" : "สมัครเครื่องนี้"}</button>
            </span>
          )}
        </SetLine>
        {err && <p className="error small" role="alert">{err}</p>}
      </SetGroup>
    </>
  );
}
