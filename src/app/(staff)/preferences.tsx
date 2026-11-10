"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { applyPreferences, effectiveTheme, normalizePreferences, type Preferences } from "@/lib/theme";
import { Icon } from "./icons";

interface PrefsCtx { prefs: Preferences; update: (patch: Partial<Preferences>) => Promise<string | null>; systemDark: boolean }
const Ctx = createContext<PrefsCtx | null>(null);

/**
 * ตั้งค่าส่วนตัวของผู้ใช้ (หมวด "การแสดงผล") ใช้ร่วมกันทั้งเมนูซ้ายและหน้าตั้งค่า
 * เปลี่ยนแล้วมีผลทันที บันทึกในฐานข้อมูล และ sync ไปทุกเครื่องของผู้ใช้คนนั้นผ่าน realtime
 * (แก้ปัญหาปิดเสียงที่เครื่องหนึ่งแล้วอีกเครื่องยังดัง)
 */
export function PreferencesProvider({ userId, initial, children }: { userId: string; initial: Preferences; children: React.ReactNode }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [prefs, setPrefs] = useState<Preferences>(initial);
  const [systemDark, setSystemDark] = useState(false);
  const latest = useRef(prefs);
  latest.current = prefs;

  // ค่าจากฐานข้อมูลอาจต่างจาก cookie ของเครื่องนี้ (เพิ่งเปลี่ยนจากเครื่องอื่น): ใช้ค่าจากฐานข้อมูลและเขียน cookie ใหม่
  useEffect(() => { applyPreferences(initial); }, [initial]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    const channel = sb.channel(`prefs-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "user_preferences", filter: `user_id=eq.${userId}` }, (payload) => {
        const next = normalizePreferences(payload.new);
        setPrefs(next);
        applyPreferences(next);
      })
      .subscribe();
    return () => { sb.removeChannel(channel); };
  }, [sb, userId]);

  const update = useCallback(async (patch: Partial<Preferences>) => {
    const next = { ...latest.current, ...patch };
    setPrefs(next);
    applyPreferences(next);
    const res = await fetch("/api/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).catch(() => null);
    if (res?.ok) return null;
    // บันทึกไม่ได้: หน้านี้ยังใช้ค่าใหม่ (เช่น ปิดเสียงได้ทันที) แต่บอกว่ายังไม่ sync ไปเครื่องอื่น
    return `${(await res?.json().catch(() => null))?.error ?? "บันทึกไม่สำเร็จ"} — ใช้ได้เฉพาะหน้านี้ ยังไม่ sync ไปเครื่องอื่น`;
  }, []);

  const value = useMemo(() => ({ prefs, update, systemDark }), [prefs, update, systemDark]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePreferences(): PrefsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePreferences ต้องอยู่ใน PreferencesProvider");
  return ctx;
}

/** ไม่อยู่ใน provider (ภาพตัวอย่าง/เทสต์) ใช้ค่าเริ่มต้น */
export function usePreferencesOptional(): PrefsCtx | null {
  return useContext(Ctx);
}

/** ปุ่มสลับธีมเร็วในเมนูซ้าย (ใช้ค่าเดียวกับหมวดการแสดงผล) */
export function ThemeQuickToggle() {
  const { prefs, update, systemDark } = usePreferences();
  const dark = effectiveTheme(prefs.theme, systemDark) === "dark";
  const label = dark ? "เปลี่ยนเป็นธีมสว่าง" : "เปลี่ยนเป็นธีมมืด";
  return (
    <button type="button" className="btn ghost small nav-quick" onClick={() => update({ theme: dark ? "light" : "dark" })} aria-label={label} title={label}>
      <Icon name={dark ? "sun" : "moon"} size={16} />
      <span className="nav-label">{dark ? "ธีมสว่าง" : "ธีมมืด"}</span>
    </button>
  );
}
