import Link from "next/link";
import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { labUnmatchedCount } from "@/lib/lab-results-store";
import { canOpenSettings } from "@/lib/settings-access";
import { Icon, type IconName } from "../icons";
import { InstallApp } from "../install-app";
import { LabBadge } from "../lab-badge";
import { SoundSwitchRow, ThemeSwitchRow } from "../preferences";
import { PushToggle } from "../push-toggle";
import { SignOut } from "../sign-out";
import { TodayScore } from "../today-score";

/**
 * หน้าเมนูบนมือถือ (ปุ่ม "เมนู" แถบล่าง) ตามแบบ: หน้าอื่น ๆ · สวิตช์ · ชื่อ + ออกจากระบบ
 * ตัวเล่นเสียงเตือนยังอยู่ที่เมนูซ้ายตัวเดียว ที่นี่เป็นแค่สวิตช์ ไม่เล่นเสียงซ้ำ
 */
export default async function MenuPage() {
  const me = await getStaffContext();
  if (!me) redirect("/login");
  const isAdmin = me.role === "admin";
  const chatStaff = me.role !== "pharmacy";
  const lab = chatStaff ? await labUnmatchedCount().catch(() => 0) : 0;
  const links: { href: string; icon: IconName; label: string; show: boolean; badge?: React.ReactNode }[] = [
    { href: "/lab-results", icon: "flask", label: "ผลแล็บ", show: chatStaff, badge: <LabBadge initial={lab} channel="lab-badge-menu" /> },
    { href: "/reports", icon: "chart", label: "รายงาน", show: chatStaff },
    { href: "/sensitive-log", icon: "lock", label: "ประวัติแชทลับ", show: isAdmin },
    { href: "/knowledge", icon: "book", label: "ฐานข้อมูล & คำตอบ", show: isAdmin },
    { href: "/settings", icon: "settings", label: "ตั้งค่า", show: canOpenSettings(me.role) },
  ];
  const visible = links.filter((l) => l.show);
  return (
    <div className="m-page m-menu">
      <header className="m-page-head"><h1>เมนู</h1></header>
      <div className="m-page-body">
        {visible.length > 0 && (
          <section className="m-card">
            {visible.map((l) => (
              <Link key={l.href} href={l.href} className="m-row">
                <Icon name={l.icon} size={22} />
                <span className="m-row-label">{l.label}</span>
                {l.badge}
                <Icon name="chevronRight" size={16} />
              </Link>
            ))}
          </section>
        )}
        <section className="m-card">
          <PushToggle row />
          {chatStaff && <SoundSwitchRow />}
          <ThemeSwitchRow />
          {chatStaff && <TodayScore meId={me.id} />}
        </section>
        {/* ติดตั้งแอป: แสดงเฉพาะเครื่องที่ยังไม่ได้ติดตั้ง */}
        <InstallApp />
        <section className="m-card m-me">
          <span className="muted">{me.displayName}</span>
          <SignOut />
        </section>
      </div>
    </div>
  );
}
