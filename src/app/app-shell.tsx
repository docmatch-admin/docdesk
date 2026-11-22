"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";

/** ปลายทางหลังเช็ก session: ล็อกอินอยู่ → แชท (ห้องยา server พาไปนัดหมายเอง) · ไม่มี session → หน้าเข้าสู่ระบบ ครั้งเดียว ไม่วนหลายรอบ */
export const SHELL_TARGET = { signedIn: "/inbox", signedOut: "/login" } as const;

/**
 * App shell: หน้าแรกเมื่อเปิด DocDesk จากไอคอน (start_url /start?source=pwa) และหน้า /
 * เป็นไฟล์ static ไม่รอ server เช็กสิทธิ์/ดึงข้อมูล → service worker เปิดจาก cache ได้ทันที (เมนู + โครงรายการแชท)
 * ไม่มีข้อมูลคนไข้หรือชื่อเจ้าหน้าที่ในหน้านี้ · session อ่านจาก cookie ในเครื่อง (getSession ไม่ยิงเน็ตถ้า token ยังไม่หมดอายุ)
 * แล้วค่อยเปลี่ยนไปหน้าแชทแบบไม่โหลดทั้งหน้า (หน้านี้ค้างให้เห็นจนหน้าแชทพร้อม)
 */
export function AppShell() {
  const router = useRouter();
  useEffect(() => {
    router.prefetch(SHELL_TARGET.signedIn);
    let gone = false;
    supabaseBrowser().auth.getSession()
      .then(({ data }) => {
        if (gone) return;
        if (data.session) router.replace(SHELL_TARGET.signedIn);
        else window.location.replace(SHELL_TARGET.signedOut);
      })
      .catch(() => { if (!gone) router.replace(SHELL_TARGET.signedIn); });
    return () => { gone = true; };
  }, [router]);

  return (
    <div className="staff-root app-shell" aria-busy="true" aria-label="กำลังเปิด DocDesk">
      <div className="shell">
        <nav className="nav" aria-hidden="true">
          <div className="brand"><span className="nav-label">Doc<span>Desk</span></span><span className="brand-short">D</span></div>
          {Array.from({ length: 5 }, (_, i) => <div key={i} className="sk-nav"><span className="sk sk-icon" /><span className="sk sk-line nav-label" /></div>)}
        </nav>
        <main className="main">
          <div className="inbox">
            <div className="conv-list sk-list" aria-hidden="true">
              <div className="m-inbox-head">Doc<span>Desk</span></div>
              <div className="sk sk-search" />
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className="sk-row">
                  <span className="sk sk-avatar" />
                  <span className="sk-text"><span className="sk sk-line" style={{ width: `${55 + ((i * 17) % 35)}%` }} /><span className="sk sk-line short" /></span>
                </div>
              ))}
            </div>
            <div className="sk-empty muted">กำลังเปิด DocDesk…</div>
          </div>
        </main>
      </div>
      <div className="mobile-tabbar sk-tabbar" aria-hidden="true"><span className="sk sk-pill" /><span className="sk sk-pill" /><span className="sk sk-pill" /></div>
    </div>
  );
}
