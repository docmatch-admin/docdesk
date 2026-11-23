"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChatBadge } from "./chat-badge";
import { AppointmentBadge } from "./appointment-badge";
import { LabBadge } from "./lab-badge";
import { Icon } from "./icons";

type Counts = { mustCall: number; reschedule: number; total: number };

/**
 * แถบล่างบนมือถือ (≤ 899px) ตามแบบ: แชท · นัดหมาย · เมนู — ไอคอนพร้อมชื่อทุกปุ่ม ปุ่มที่อยู่เป็นสีหลัก
 * "เมนู" ไปหน้า /menu · หน้าอื่น ๆ (ผลแล็บ รายงาน ตั้งค่า ฯลฯ) นับเป็นอยู่ในเมนู
 */
export function MobileNav({ chatStaff, calls, labUnmatched = 0 }: { chatStaff: boolean; calls: Counts; labUnmatched?: number }) {
  const path = usePathname();
  const on = (href: string) => path === href || path.startsWith(`${href}/`);
  const inMenu = !on("/inbox") && !on("/appointments");

  return (
    <nav className="mobile-tabbar" aria-label="เมนูหลัก">
      {chatStaff && (
        <Link href="/inbox" aria-label="แชท" className={on("/inbox") ? "on" : ""} aria-current={on("/inbox") ? "page" : undefined}>
          <span className="mnav-icon"><Icon name="chat" size={22} /><ChatBadge /></span><span>แชท</span>
        </Link>
      )}
      <Link href="/appointments" aria-label="นัดหมาย" className={on("/appointments") ? "on" : ""} aria-current={on("/appointments") ? "page" : undefined}>
        <span className="mnav-icon"><Icon name="calendar" size={22} /><AppointmentBadge initial={calls} channel="appointment-badge-mobile" /></span>
        <span>นัดหมาย</span>
      </Link>
      <Link href="/menu" aria-label="เมนู" className={inMenu ? "on" : ""} aria-current={on("/menu") ? "page" : undefined}>
        <span className="mnav-icon"><Icon name="menu" size={22} />{chatStaff && <LabBadge initial={labUnmatched} channel="lab-badge-mobile" dot />}</span><span>เมนู</span>
      </Link>
    </nav>
  );
}
