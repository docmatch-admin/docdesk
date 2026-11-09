import Link from "next/link";
import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { ImportsClient } from "../imports/imports-client";
import { PasteClient } from "../imports/paste/paste-client";
import { KnowledgeClient } from "./knowledge-client";

type Tab = "kb" | "import";

/** ฐานข้อมูล & คำตอบ + นำเข้าคำตอบ (เดิมเป็นเมนูแยก) ทั้งสองแท็บเฉพาะ admin เหมือนหน้าเดิม */
export default async function KnowledgePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  if ((await getStaffContext())?.role !== "admin") redirect("/inbox");
  const tab: Tab = (await searchParams).tab === "import" ? "import" : "kb";
  return (
    <div className="page">
      <h1>ฐานข้อมูล &amp; คำตอบ</h1>
      <nav className="tabs wide page-tabs" aria-label="ส่วนของหน้า">
        <Link href="/knowledge?tab=kb" className={tab === "kb" ? "on" : ""} aria-current={tab === "kb" ? "page" : undefined}>ฐานข้อมูล &amp; คำตอบ</Link>
        <Link href="/knowledge?tab=import" className={tab === "import" ? "on" : ""} aria-current={tab === "import" ? "page" : undefined}>นำเข้าคำตอบ</Link>
      </nav>
      {tab === "kb" ? (
        <>
          <p className="muted">AI ใช้ฐานข้อมูลคลินิกเป็นแหล่งหลัก (ข้อมูลล่าสุดเสมอ) และใช้คำตอบเดิมของเจ้าหน้าที่เป็นแบบอย่างสำนวน</p>
          <KnowledgeClient embedded />
        </>
      ) : (
        <div className="import-tab">
          <PasteClient embedded />
          <ImportsClient embedded />
        </div>
      )}
    </div>
  );
}
