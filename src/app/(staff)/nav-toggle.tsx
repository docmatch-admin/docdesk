"use client";

import { Icon } from "./icons";
import { usePreferences } from "./preferences";

/** ย่อ/ขยายเมนู = ค่า "ย่อเมนูเป็นค่าเริ่มต้น" ในหมวดการแสดงผล (sync ทุกเครื่อง) */
export function NavToggle() {
  const { prefs, update } = usePreferences();
  const collapsed = prefs.nav_collapsed;
  return (
    <button type="button" className="nav-toggle" onClick={() => update({ nav_collapsed: !collapsed })}
      aria-label={collapsed ? "ขยายเมนู" : "ย่อเมนู"} aria-expanded={!collapsed} title={collapsed ? "ขยายเมนู" : "ย่อเมนู"}>
      <span className={`nav-icon ${collapsed ? "flip" : ""}`} aria-hidden="true"><Icon name="chevronLeft" size={20} /></span>
      <span className="nav-label">ย่อเมนู</span>
    </button>
  );
}
