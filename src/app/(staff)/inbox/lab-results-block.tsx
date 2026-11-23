"use client";

import { useEffect, useState } from "react";
import { chatBundle } from "@/lib/chat-bundle";
import { NOTIFY_LABEL, type LabResult } from "@/lib/lab-results-rules";

/** ผลแล็บของคนไข้ที่ผูกกับแชทนี้ (แผงขวา) — ไม่มีผลก็ไม่แสดงบล็อก · ข้อมูลนี้ไม่เข้า AI */
export function LabResultsBlock({ conversationId, blurred }: { conversationId: string; blurred: boolean }) {
  const [rows, setRows] = useState<LabResult[]>([]);

  useEffect(() => {
    let alive = true;
    setRows([]);
    // ตอนเปิดแชทใช้ข้อมูลชุดเดียวกับห้องแชท ถ้าไม่ได้จึงโหลดเอง
    chatBundle(conversationId).then((b) => {
      if (!alive) return;
      if (b?.labResults) return setRows(b.labResults as LabResult[]);
      fetch(`/api/lab-results?conversation=${encodeURIComponent(conversationId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (alive) setRows(j?.results ?? []); })
        .catch(() => {});
    });
    return () => { alive = false; };
  }, [conversationId]);

  if (!rows.length) return null;
  // ตามแบบ: แสดงผลล่าสุดบรรทัดเดียว กดแล้วไปหน้าผลแล็บ (ดู PDF / จัดการอยู่ที่นั่น)
  const r = rows[0];
  const day = r.order_datetime
    ? new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", timeZone: "Asia/Bangkok" }).format(new Date(r.order_datetime))
    : "–";
  const status = r.notify_status === "sent" ? "ส่งทาง LINE แล้ว" : NOTIFY_LABEL[r.notify_status];
  return (
    <a className={`lab-latest ${blurred ? "sensitive-blur" : ""}`} href={`/lab-results?id=${r.id}`} title={r.notify_error ?? "ดูผลแล็บ"}>
      <span className="lab-latest-label">ผลแล็บล่าสุด</span>
      <span className="lab-latest-date">{day}{r.version_number > 1 ? " · ฉบับแก้ไข" : ""}{rows.length > 1 ? ` · ทั้งหมด ${rows.length}` : ""}</span>
      <span className={`lab-latest-status ${r.notify_status}`}>{status}</span>
    </a>
  );
}
