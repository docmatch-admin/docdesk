"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icons";

export const NAV_KEY = "docdesk_nav_collapsed";

/**
 * อ่านค่าก่อนวาดหน้า ไม่ให้เมนูกระพริบจากกว้างเป็นแคบ ใส่เป็น <script> แรกใน layout
 * localStorage อาจใช้ไม่ได้ เช่น โหมดส่วนตัว จึงครอบ try/catch และใช้ค่าเริ่มต้นแบบกว้าง
 */
export const NAV_BOOT_SCRIPT = `try{if(localStorage.getItem("${NAV_KEY}")==="1")document.documentElement.dataset.nav="collapsed"}catch(e){}`;

export function NavToggle() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(document.documentElement.dataset.nav === "collapsed"); }, []);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    if (next) document.documentElement.dataset.nav = "collapsed";
    else delete document.documentElement.dataset.nav;
    try { localStorage.setItem(NAV_KEY, next ? "1" : "0"); } catch { /* จำไม่ได้ก็ใช้แค่หน้านี้ */ }
  }

  return (
    <button type="button" className="nav-toggle" onClick={toggle}
      aria-label={collapsed ? "ขยายเมนู" : "ย่อเมนู"} aria-expanded={!collapsed} title={collapsed ? "ขยายเมนู" : "ย่อเมนู"}>
      <span className={`nav-icon ${collapsed ? "flip" : ""}`} aria-hidden="true"><Icon name="chevronLeft" size={20} /></span>
      <span className="nav-label">ย่อเมนู</span>
    </button>
  );
}
