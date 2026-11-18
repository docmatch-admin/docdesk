"use client";

import { useEffect, useState } from "react";
import { MATCH_LABEL, NOTIFY_LABEL, type LabResult } from "@/lib/lab-results-rules";
import { Icon } from "../icons";

type Patch = (id: string, body: Record<string, unknown>, okText: (j: Record<string, unknown>) => string) => Promise<void>;

/** รายละเอียดผลแล็บแบบ drawer ด้านขวา (เหมือนระบบนัด) — จัดการทุกอย่างของรายการนี้ที่นี่ */
export function LabDrawer({ r, appt, busy, onClose, onPatch, whenTh, notifyClass, notifyText }: {
  r: LabResult; appt: string | null; busy: boolean; onClose: () => void; onPatch: Patch;
  whenTh: (iso: string | null) => string; notifyClass: string; notifyText: (n: unknown) => string;
}) {
  const unmatched = r.match_status === "unmatched";
  const [editing, setEditing] = useState(unmatched);
  const [hn, setHn] = useState(unmatched ? (r.location_hn ?? "").replace(/\D/g, "").slice(0, 9) : r.patient_id?.replace(/^0+/, "") ?? "");

  useEffect(() => {
    setEditing(r.match_status === "unmatched");
    setHn(r.match_status === "unmatched" ? (r.location_hn ?? "").replace(/\D/g, "").slice(0, 9) : r.patient_id?.replace(/^0+/, "") ?? "");
  }, [r.id, r.match_status, r.patient_id, r.location_hn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canNotify = !!r.patient_id && !!r.pdf_path && (r.notify_status === "unreachable" || r.notify_status === "failed");
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
            <div className="muted small">{r.ln ? `LN ${r.ln} · ` : ""}สั่งตรวจ {whenTh(r.order_datetime)}</div>
            <div className="drawer-chips">
              <span className={notifyClass}>{NOTIFY_LABEL[r.notify_status]}</span>
              {unmatched && <span className="lab-chip bad">รอจับคู่</span>}
              {r.match_status === "manual" && <span className="lab-chip">จับคู่เอง</span>}
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
              <b>ยังไม่รู้ว่าเป็นผลของคนไข้คนไหน</b>
              <span className="small">{r.location_hn ? `แล็บอ่าน HN จากใบส่งตรวจได้ว่า "${r.location_hn}" — ตรวจให้ถูกก่อนบันทึก` : "แล็บอ่าน HN จากใบส่งตรวจไม่ได้"}</span>
            </section>
          )}

          {canNotify && (
            <section className="lab-drawer-box" aria-label="ส่งแจ้งคนไข้">
              <span className="small">{r.notify_status === "unreachable"
                ? "ตอนผลออก คนไข้ยังไม่ได้ผูก LINE ระบบจึงไม่ได้ส่ง — ถ้าคนไข้ผูก LINE แล้ว กดส่งได้เลย"
                : `ส่งไม่สำเร็จ${r.notify_error ? `: ${r.notify_error}` : ""}`}</span>
              <button type="button" className="btn primary small" disabled={busy} onClick={() => onPatch(r.id, { action: "notify" }, (j) => notifyText(j.notify))}>ส่งแจ้งคนไข้ทาง LINE</button>
            </section>
          )}

          <dl className="drawer-dl">
            <dt>แจ้งคนไข้</dt>
            <dd>{NOTIFY_LABEL[r.notify_status]}{r.notify_status === "sent" && r.notified_at ? ` · ${whenTh(r.notified_at)}` : ""}
              {r.notify_error && r.notify_status === "sent" && <div className="muted small">ส่งไม่ถึงบางบัญชี: {r.notify_error}</div>}</dd>
            <dt>คนไข้เปิดดู</dt>
            <dd>{r.first_viewed_at ? `${whenTh(r.first_viewed_at)}${r.view_count > 1 ? ` · ${r.view_count} ครั้ง` : ""}` : "ยังไม่เปิด"}</dd>
            <dt>นัดฟังผล</dt>
            <dd>{appt ?? <span className="muted">ไม่มีนัด</span>}</dd>
            <dt>การจับคู่</dt>
            <dd>{MATCH_LABEL[r.match_status]}</dd>
          </dl>

          <section className="lab-drawer-match" aria-label="คนไข้ของผลนี้">
            {!editing ? (
              <button type="button" className="link-btn small" onClick={() => setEditing(true)}>จับคู่ผิดคน? เปลี่ยนคนไข้</button>
            ) : (
              <form onSubmit={(e) => {
                e.preventDefault();
                onPatch(r.id, { action: "match", hn }, (j) => (j.matched ? `จับคู่แล้ว · ${notifyText(j.notify)}` : "ยกเลิกการจับคู่แล้ว"));
              }}>
                <label>HN คนไข้
                  <input inputMode="numeric" placeholder="เช่น 4807" value={hn} autoFocus={unmatched}
                    onChange={(e) => setHn(e.target.value.replace(/\D/g, "").slice(0, 9))} />
                </label>
                <p className="muted small">บันทึกแล้ว ถ้าคนไข้คนนี้ผูก LINE ไว้ ระบบจะส่งแจ้ง "ผลแล็บออกแล้ว" ทันที</p>
                <div className="drawer-actions">
                  <button type="submit" className="btn primary small" disabled={busy || !hn}>{unmatched ? "จับคู่คนไข้" : "บันทึก HN ใหม่"}</button>
                  {!unmatched && <button type="button" className="btn ghost small" disabled={busy}
                    onClick={() => onPatch(r.id, { action: "match", hn: "" }, () => "ยกเลิกการจับคู่แล้ว")}>ยกเลิกจับคู่</button>}
                  {!unmatched && <button type="button" className="link-btn small" onClick={() => setEditing(false)}>ปิด</button>}
                </div>
              </form>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
