"use client";

import { useEffect, useState } from "react";
import { NOTIFY_LABEL, type LabResult } from "@/lib/lab-results-rules";
import { NOTIFY_CLASS, whenTh } from "../lab-results/lab-results-client";

const SHOW = 5;

/** ผลแล็บของคนไข้ที่ผูกกับแชทนี้ (แผงขวา) — ไม่มีผลก็ไม่แสดงบล็อก · ข้อมูลนี้ไม่เข้า AI */
export function LabResultsBlock({ conversationId, blurred }: { conversationId: string; blurred: boolean }) {
  const [rows, setRows] = useState<LabResult[]>([]);

  useEffect(() => {
    let alive = true;
    setRows([]);
    fetch(`/api/lab-results?conversation=${encodeURIComponent(conversationId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setRows(j?.results ?? []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [conversationId]);

  if (!rows.length) return null;
  return (
    <section className="side-block lab-side">
      <div className="side-head"><h3>ผลแล็บ</h3><a className="link-btn small" href="/lab-results">ทั้งหมด</a></div>
      <div className={blurred ? "sensitive-blur" : undefined}>
        {rows.slice(0, SHOW).map((r) => (
          <div key={r.id} className="lab-side-row">
            <div className="lab-side-meta">
              <b>{whenTh(r.order_datetime)}</b>
              {r.version_number > 1 && <span className="lab-chip wait">ฉบับแก้ไข</span>}
            </div>
            <div className="lab-side-meta">
              <span className={NOTIFY_CLASS[r.notify_status]} title={r.notify_error ?? undefined}>{NOTIFY_LABEL[r.notify_status]}</span>
              {r.notify_status === "failed" && r.notify_error && <span className="error small">{r.notify_error}</span>}
              <span className="muted small">{r.first_viewed_at ? `คนไข้เปิดดูแล้ว ${r.view_count} ครั้ง` : r.notify_status === "sent" ? "ยังไม่เปิด" : ""}</span>
            </div>
            <div className="lab-side-meta">
              {r.pdf_path && <a className="link-btn small" href={`/api/lab-results/${r.id}/pdf`} target="_blank" rel="noopener noreferrer">ดู PDF</a>}
              <a className="link-btn small" href={`/lab-results?id=${r.id}`}>จัดการ</a>
            </div>
          </div>
        ))}
        {rows.length > SHOW && <div className="muted small">และอีก {rows.length - SHOW} รายการ</div>}
      </div>
    </section>
  );
}
