import Link from "next/link";
import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { HealthBanner } from "./health-banner";
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

  return (
    <div className="staff-root">
      <HealthBanner />
      <div className="shell">
      <nav className="nav">
        <div className="brand">Doc<span>Desk</span></div>
        <Link href="/inbox">💬 แชท</Link>
        {isAdmin && <Link href="/knowledge">📚 ฐานข้อมูล &amp; คำตอบ</Link>}
        <Link href="/bookings">📅 นัดหมาย</Link>
        <Link href="/reports">📊 รายงาน</Link>
        {isAdmin && <Link href="/imports/paste">📋 นำเข้าคำตอบ</Link>}
        {isAdmin && <Link href="/staff">👥 เจ้าหน้าที่</Link>}
        {isAdmin && <Link href="/sensitive-log">🔒 ประวัติแชทลับ</Link>}
        {isAdmin && <Link href="/settings">⚙️ ตั้งค่า AI</Link>}
        <div className="nav-foot">
          <TodayScore meId={me.id} />
          <WaitingAlert meId={me.id} />
          <PushToggle />
          <div className="muted small">{me.displayName}</div>
          <SignOut />
        </div>
      </nav>
      <main className="main">{children}</main>
      </div>
    </div>
  );
}
