"use client";

import { useEffect, useState } from "react";
import { applyTheme, normalizeTheme, THEME_KEY, THEME_LABEL, type ThemeChoice } from "@/lib/theme";
import { SetGroup, SetLine } from "./settings-save";

const CHOICES: ThemeChoice[] = ["system", "light", "dark"];

/** การแสดงผล: สว่าง/มืด มีผลทันทีและจำต่อเครื่อง (ไม่ต้องกดบันทึกการตั้งค่า) */
export function ThemeSettings() {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    try { setChoice(normalizeTheme(localStorage.getItem(THEME_KEY))); } catch { /* โหมดส่วนตัว/บล็อก storage: ใช้ตามเครื่อง */ }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  function pick(c: ThemeChoice) {
    setChoice(c);
    applyTheme(c);
    try {
      if (c === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, c);
    } catch { /* เก็บไม่ได้ก็ยังเปลี่ยนในหน้านี้ */ }
  }

  return (
    <SetGroup title="การแสดงผล" info="จำต่อเครื่องและเบราว์เซอร์ เครื่องอื่นของทีมไม่เปลี่ยนตาม · มีผลทันที ไม่ต้องกดบันทึก">
      <SetLine label="ธีม" desc={`ตามเครื่อง = ใช้ตามการตั้งค่าของคอมหรือมือถือ (ตอนนี้เครื่องตั้งเป็น${systemDark ? "มืด" : "สว่าง"})`}>
        <div className="theme-choice" role="radiogroup" aria-label="ธีม">
          {CHOICES.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={choice === c} onClick={() => pick(c)}>{THEME_LABEL[c]}</button>
          ))}
        </div>
      </SetLine>
    </SetGroup>
  );
}
