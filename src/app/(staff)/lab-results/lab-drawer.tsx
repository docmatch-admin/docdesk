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
  const startHn = unmatched ? (r.location_hn ?? "").replace(/\D/g, "").slice(0, 9) : r.patient_id?.replace(/^0+/, "") ?? "";
  const [hn, setHn] = useState(startHn);
  useEffect(() => { setHn(startHn); }, [r.id, startHn]);

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

          {/* ปุ่มอยู่ที่เดิมเสมอ: ใช้ไม่ได้ = สีจาง + บอกเหตุผลใต้ปุ่ม */}
          <div className="lab-drawer-actions">
            {r.pdf_path
              ? <a className="btn ghost" href={`/api/lab-results/${r.id}/pdf`} target="_blank" rel="noopener noreferrer">ดู PDF</a>
              : <button type="button" className="btn ghost" disabled>ดู PDF</button>}
            <button type="button" className="btn primary" disabled={busy || !canNotify}
              onClick={() => onPatch(r.id, { action: "notify" }, (j) => notifyText(j.notify))}>ส่งผลแล็บทาง LINE</button>
          </div>
          <p className="muted small lab-drawer-why">{
            !r.pdf_path ? (r.pdf_error ? `ยังเปิดไฟล์ไม่ได้: โหลดไฟล์ไม่สำเร็จ (${r.pdf_error})` : "ยังไม่มีไฟล์ผล รอรอบดึงถัดไป")
              : unmatched ? "ส่งผลไม่ได้: ต้องผูกคนไข้ก่อน"
              : linkedLater ? "คนไข้ผูก LINE หลังผลออก ระบบยังไม่ได้ส่ง — กดส่งผลได้เลย"
              : r.notify_status === "failed" ? `ส่งไม่สำเร็จ${r.notify_error ? `: ${r.notify_error}` : ""} — กดส่งใหม่ได้`
              : r.notify_status === "unreachable" ? "คนไข้ยังไม่ได้ผูก LINE — ไม่ต้องทำอะไร ถ้าคนไข้ผูก LINE ภายหลัง ปุ่มส่งจะกดได้"
              : r.notify_status === "sent" ? "ส่งแจ้งคนไข้แล้ว คนไข้กดดูผลจากข้อความเดิมได้ตลอด"
              : "ระบบจะส่งแจ้งคนไข้เองในรอบดึงผลถัดไป"
          }</p>

          {unmatched && (
            <section className="lab-drawer-box warn" aria-label="ไม่พบ HN">
              <b>แล็บอ่าน HN จากใบส่งตรวจไม่ได้</b>
              <span className="small">{r.location_hn ? `แล็บอ่านได้ว่า "${r.location_hn}" — ดูชื่อแล้วใส่ HN ที่ถูกด้านล่าง` : "ดูชื่อคนไข้แล้วใส่ HN ด้านล่าง"}</span>
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
          </dl>

          {/* กล่อง HN อยู่ที่เดิมเสมอ: ไม่พบ HN = ผูกคนไข้ · มี HN แล้ว = แก้ HN ได้ (ปุ่มกดได้เมื่อเลขเปลี่ยน) */}
          <section className="lab-drawer-match" aria-label="HN คนไข้">
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!hn || hn === (hnText ?? "")) return;
              onPatch(r.id, { action: "match", hn }, (j) => (j.matched ? `บันทึก HN ${hn} แล้ว · ${notifyText(j.notify)}` : "บันทึกแล้ว"));
            }}>
              <label>{unmatched ? "ผูกคนไข้ — ใส่ HN" : "HN คนไข้ (แก้ได้ถ้าผิด)"}
                <input inputMode="numeric" placeholder="เช่น 4807" value={hn} autoFocus={unmatched}
                  onChange={(e) => setHn(e.target.value.replace(/\D/g, "").slice(0, 9))} />
              </label>
              <div className="drawer-actions">
                <button type="submit" className="btn primary small" disabled={busy || !hn || hn === (hnText ?? "")}>{unmatched ? "ผูกคนไข้" : "บันทึก HN ใหม่"}</button>
              </div>
              <p className="muted small">{unmatched
                ? "ดูชื่อคนไข้ให้ตรงก่อนบันทึก"
                : "เปลี่ยน HN แล้ว ถ้าคนไข้คนใหม่ผูก LINE ไว้ ระบบจะส่งแจ้งผลให้คนใหม่ทันที"}</p>
            </form>
          </section>
        </div>
      </aside>
    </div>
  );
}
