import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { HealthBanner } from "./health-banner";
import { SignOut } from "./sign-out";
import { WaitingAlert } from "./waiting-alert";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data: staff } = await sb.from("staff").select("display_name").eq("id", user.id).maybeSingle();

  return (
    <div className="staff-root">
      <HealthBanner />
      <div className="shell">
      <nav className="nav">
        <div className="brand">Doc<span>Desk</span></div>
        <Link href="/inbox">💬 แชท</Link>
        <Link href="/knowledge">📚 ฐานข้อมูล &amp; คำตอบ</Link>
        <Link href="/reports">📊 รายงาน</Link>
        <Link href="/settings">⚙️ ตั้งค่า AI</Link>
        <div className="nav-foot">
          <WaitingAlert />
          <div className="muted small">{staff?.display_name ?? user.email}</div>
          <SignOut />
        </div>
      </nav>
      <main className="main">{children}</main>
      </div>
    </div>
  );
}
