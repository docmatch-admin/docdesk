import Link from "next/link";
import { redirect } from "next/navigation";
import { appointmentCallCounts } from "@/lib/appointment-store";
import { getStaffContext } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { AppointmentBadge } from "./appointment-badge";
import { HealthBanner } from "./health-banner";
import { QuotaBanner } from "./quota-banner";
import { Icon } from "./icons";
import { NavToggle } from "./nav-toggle";
import { PreferencesProvider, ThemeQuickToggle } from "./preferences";
import { loadPreferences } from "@/lib/preferences-store";
import { canOpenSettings } from "@/lib/settings-access";
import { PushToggle } from "./push-toggle";
import { SignOut } from "./sign-out";
import { TodayScore } from "./today-score";
import { WaitingAlert } from "./waiting-alert";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const me = await getStaffContext();
  if (!me) {
    return (
      <div className="login">
        <div className="card login-card">
          <b>บัญชีนี้ใช้งานไม่ได้</b>
          <p className="muted small">บัญชีถูกปิดหรือยังไม่ได้เพิ่มเป็นเจ้าหน้าที่ กรุณาติดต่อผู้ดูแลระบบ</p>
          <SignOut />
        </div>
      </div>
    );
  }
  if (me.mustChangePassword) redirect("/change-password");
  const isAdmin = me.role === "admin";
  // ห้องยาเห็นเฉพาะเมนูนัดหมาย
  const chatStaff = me.role !== "pharmacy";
  const [calls, prefs] = await Promise.all([
    appointmentCallCounts().catch(() => ({ total: 0, mustCall: 0, reschedule: 0 })),
    loadPreferences(me.id),
  ]);

  return (
    <PreferencesProvider userId={me.id} initial={prefs}>
    <div className="staff-root">
      <HealthBanner />
      <QuotaBanner />
      <div className="shell">
      <nav className="nav">
        <div className="brand"><span className="nav-label">Doc<span>Desk</span></span><span className="brand-short" aria-hidden="true">D</span></div>
        {chatStaff && <Link href="/inbox" title="แชท"><span className="nav-icon" aria-hidden="true"><Icon name="chat" size={20} /></span><span className="nav-label">แชท</span></Link>}
        <Link href="/appointments" title="นัดหมาย">
          <span className="nav-icon" aria-hidden="true"><Icon name="calendar" size={20} /></span><span className="nav-label">นัดหมาย</span>
          <AppointmentBadge initial={calls} />
        </Link>
        {chatStaff && <Link href="/reports" title="รายงาน"><span className="nav-icon" aria-hidden="true"><Icon name="chart" size={20} /></span><span className="nav-label">รายงาน</span></Link>}
        {isAdmin && <Link href="/staff" title="เจ้าหน้าที่"><span className="nav-icon" aria-hidden="true"><Icon name="users" size={20} /></span><span className="nav-label">เจ้าหน้าที่</span></Link>}
        {isAdmin && <Link href="/sensitive-log" title="ประวัติแชทลับ"><span className="nav-icon" aria-hidden="true"><Icon name="lock" size={20} /></span><span className="nav-label">ประวัติแชทลับ</span></Link>}
        {canOpenSettings(me.role) && <Link href="/settings" title="ตั้งค่า"><span className="nav-icon" aria-hidden="true"><Icon name="settings" size={20} /></span><span className="nav-label">ตั้งค่า</span></Link>}
        {isAdmin && <Link href="/knowledge" title="ฐานข้อมูล & คำตอบ"><span className="nav-icon" aria-hidden="true"><Icon name="book" size={20} /></span><span className="nav-label">ฐานข้อมูล &amp; คำตอบ</span></Link>}
        <div className="nav-foot">
          {/* ตอนย่อเมนูซ่อนส่วนนี้ เหลือแค่ปุ่มขยาย */}
          <div className="nav-extra">
            {chatStaff && <TodayScore meId={me.id} />}
            {chatStaff && <WaitingAlert meId={me.id} />}
            <PushToggle />
            <ThemeQuickToggle />
            <div className="muted small">{me.displayName}</div>
            <SignOut />
          </div>
          <NavToggle />
        </div>
      </nav>
      <main className="main">{children}</main>
      </div>
    </div>
    </PreferencesProvider>
  );
}
