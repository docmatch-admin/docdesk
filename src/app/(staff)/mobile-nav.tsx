"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AppointmentBadge } from "./appointment-badge";
import { Icon } from "./icons";

type Counts = { mustCall: number; reschedule: number; total: number };

/**
 * แถบเมนูลอยด้านล่างบนมือถือ (≤ 899px): แชท · นัดหมาย · เมนู — ปุ่มที่เปิดอยู่แสดงชื่อ ปุ่มอื่นแสดงแค่ไอคอน
 * "เมนู" เปิดเมนูซ้ายเดิมเป็นแผ่นเลื่อนขึ้นจากด้านล่าง (ไม่ render ซ้ำ ใช้ .nav ตัวเดิม → เสียงเตือน/แจ้งเตือนไม่ซ้อน)
 */
export function MobileNav({ chatStaff, calls }: { chatStaff: boolean; calls: Counts }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  // เปลี่ยนหน้า = ปิดเมนู
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    document.documentElement.toggleAttribute("data-mnav-open", open);
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const on = (href: string) => path === href || path.startsWith(`${href}/`);
  const inMore = !on("/inbox") && !on("/appointments");

  return (
    <>
      {open && <button type="button" className="mnav-backdrop" aria-label="ปิดเมนู" onClick={() => setOpen(false)} />}
      <nav className="mobile-tabbar" aria-label="เมนูหลัก">
        {chatStaff && (
          <Link href="/inbox" aria-label="แชท" className={on("/inbox") ? "on" : ""} aria-current={on("/inbox") ? "page" : undefined}>
            <Icon name="chat" size={22} /><span>แชท</span>
          </Link>
        )}
        <Link href="/appointments" aria-label="นัดหมาย" className={on("/appointments") ? "on" : ""} aria-current={on("/appointments") ? "page" : undefined}>
          <span className="mnav-icon"><Icon name="calendar" size={22} /><AppointmentBadge initial={calls} channel="appointment-badge-mobile" /></span>
          <span>นัดหมาย</span>
        </Link>
        <button type="button" aria-label="เมนู" className={inMore || open ? "on" : ""} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)}>
          <Icon name="menu" size={22} /><span>เมนู</span>
        </button>
      </nav>
    </>
  );
}
