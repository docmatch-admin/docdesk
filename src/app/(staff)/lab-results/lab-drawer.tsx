"use client";

import { useEffect, useState } from "react";
import { NOTIFY_LABEL, type LabResult } from "@/lib/lab-results-rules";
import { Icon } from "../icons";

type Patch = (id: string, body: Record<string, unknown>, okText: (j: Record<string, unknown>) => string) => Promise<void>;

/** รายละเอียดผลแล็บแบบ drawer ด้านขวา (เหมือนระบบนัด) — จัดการทุกอย่างของรายการนี้ที่นี่ */
export function LabDrawer({ r, lineReady, appt, busy, onClose, onPatch, whenTh, notifyClass, notifyText }: {
  r: LabResult; lineReady: boolean; appt: string | null; busy: boolean; onClose: () => void; onPatch: Patch;
  whenTh: (iso: string | null) => string; notifyClass: string; notifyText: (n: unknown) => string;
}) {
  const unmatched = r.match_status === "unmatched";
  const [hn, setHn] = useState((r.location_hn ?? "").replace(/\D/g, "").slice(0, 9));
  useEffect(() => { setHn((r.location_hn ?? "").replace(/\D/g, "").slice(0, 9)); }, [r.id, r.location_hn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const linkedLater = r.notify_status === "unreachable" && lineReady;
  const canNotify = !!r.patient_id && !!r.pdf_path && (linkedLater || r.notify_status === "failed");
  const hnText = r.patient_id ? r.patient_id.replace(/^0+/, "") : null;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="รายละเอียดผลแล็บ" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>ผลแล็บ</h2>
          <button type="button" className="icon-btn" aria-label="ปิด" onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="drawer-body">
          <div className="drawer-summary">
            <div className="drawer-name">{r.patient_name || "–"}{hnText && <span className="muted small"> · HN {hnText}</span>}</div>
            <div className="muted small">สั่งตรวจ {whenTh(r.order_datetime)}</div>
            <div className="drawer-chips">
              {linkedLater ? <span className="lab-chip wait">ผูก LINE แล้ว · รอส่ง</span> : <span className={notifyClass}>{NOTIFY_LABEL[r.notify_status]}</span>}
              {unmatched && <span className="lab-chip bad">ไม่พบ HN</span>}
              {r.version_number > 1 && <span className="lab-chip wait">แก้ผล v{r.version_number}</span>}
            </div>
          </div>

          <div className="drawer-actions">
            {r.pdf_path
              ? <a className="btn primary" href={`/api/lab-results/${r.id}/pdf`} target="_blank" rel="noopener noreferrer">ดู PDF</a>
              : <span className="muted small">{r.pdf_error ? `โหลดไฟล์ไม่สำเร็จ: ${r.pdf_error}` : "ยังไม่มีไฟล์ รอรอบดึงถัดไป"}</span>}
          </div>

          {unmatched && (
            <section className="lab-drawer-box warn" aria-label="จับคู่คนไข้">
              <b>แล็บอ่าน HN จากใบส่งตรวจไม่ได้</b>
              <span className="small">{r.location_hn ? `แล็บอ่านได้ว่า "${r.location_hn}" — ดูชื่อแล้วใส่ HN ที่ถูกด้านล่าง` : "ดูชื่อคนไข้แล้วใส่ HN ด้านล่าง"}</span>
            </section>
          )}

          {canNotify && (
            <section className="lab-drawer-box" aria-label="ส่งแจ้งคนไข้">
              <span className="small">{linkedLater
                ? "คนไข้ผูก LINE หลังผลออก ระบบยังไม่ได้ส่ง — กดส่งผลได้เลย"
                : `ส่งไม่สำเร็จ${r.notify_error ? `: ${r.notify_error}` : ""}`}</span>
              <button type="button" className="btn primary small" disabled={busy} onClick={() => onPatch(r.id, { action: "notify" }, (j) => notifyText(j.notify))}>ส่งผลแล็บทาง LINE</button>
            </section>
          )}

          {r.notify_status === "unreachable" && !lineReady && (
            <p className="muted small">คนไข้ยังไม่ได้ผูก LINE — ไม่ต้องทำอะไร ถ้าคนไข้สแกน QR ผูก LINE ภายหลัง จะกดส่งผลได้ที่นี่</p>
          )}

          <dl className="drawer-dl">
            <dt>แจ้งคนไข้</dt>
            <dd>{NOTIFY_LABEL[r.notify_status]}{r.notify_status === "sent" && r.notified_at ? ` · ${whenTh(r.notified_at)}` : ""}
              {r.notify_error && r.notify_status === "sent" && <div className="muted small">ส่งไม่ถึงบางบัญชี: {r.notify_error}</div>}</dd>
            <dt>คนไข้เปิดดู</dt>
            <dd>{r.first_viewed_at ? `${whenTh(r.first_viewed_at)}${r.view_count > 1 ? ` · ${r.view_count} ครั้ง` : ""}` : "ยังไม่เปิด"}</dd>
            <dt>นัดฟังผล</dt>
            <dd>{appt ?? <span className="muted">ไม่มีนัด</span>}</dd>
          </dl>

          {unmatched && (
            <section className="lab-drawer-match" aria-label="ผูกคนไข้">
              <form onSubmit={(e) => {
                e.preventDefault();
                onPatch(r.id, { action: "match", hn }, (j) => (j.matched ? `ผูกคนไข้แล้ว · ${notifyText(j.notify)}` : "บันทึกแล้ว"));
              }}>
                <label>ผูกคนไข้ — ใส่ HN
                  <input inputMode="numeric" placeholder="เช่น 4807" value={hn} autoFocus
                    onChange={(e) => setHn(e.target.value.replace(/\D/g, "").slice(0, 9))} />
                </label>
                <div className="drawer-actions">
                  <button type="submit" className="btn primary small" disabled={busy || !hn}>ผูกคนไข้</button>
                </div>
              </form>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
