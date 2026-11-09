"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import qrcode from "qrcode-generator";
import { thaiFullDate, thaiMediumDate, timePhrase, timeShort, type Appointment } from "@/lib/appointment-rules";

interface Slip { appointment: Appointment; clinic: string; phone: string; address: string; qrUrl: string; series?: Appointment[] }

/**
 * ใบนัดเครื่องพิมพ์ความร้อน 80mm อย่างเดียว: กระดาษยาวตามเนื้อหา ไม่มีขอบ ขาวดำล้วน
 * ซ่อนทุกอย่างในหน้าตอนพิมพ์ เหลือเฉพาะสำเนาใบนัดที่ body
 */
const PRINT_CSS = `@page { size: 80mm auto; margin: 0; }
@media print {
  html, body { width: 80mm; margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body > *:not(.appt-slip) { display: none !important; }
}`;

/** ใบนัด: ชื่อคลินิก วันเวลา ผู้นัด เหตุผลนัด และ QR ให้คนไข้สแกนเพื่อรับข้อความเตือนนัดทาง LINE */
export function PrintClient({ id, message, sent, autoPrint }: { id: string; message: string; sent: boolean; autoPrint: boolean }) {
  const [slip, setSlip] = useState<Slip | null>(null);
  const [err, setErr] = useState("");
  const printed = useRef(false);

  useEffect(() => {
    fetch(`/api/appointments/${id}`).then(async (r) => {
      if (!r.ok) return setErr((await r.json().catch(() => ({}))).error ?? "โหลดนัดไม่สำเร็จ");
      setSlip(await r.json());
    }).catch(() => setErr("โหลดนัดไม่สำเร็จ"));
  }, [id]);

  // เพิ่งบันทึกนัดหรือกดพิมพ์ซ้ำ: เปิดหน้าพิมพ์ทันที รอให้ QR และฟอนต์พร้อมก่อน
  useEffect(() => {
    if (!slip || !autoPrint || printed.current) return;
    printed.current = true;
    let cancelled = false;
    const go = () => { if (!cancelled) window.print(); };
    const t = setTimeout(() => (document.fonts?.ready ?? Promise.resolve()).then(go), 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [slip, autoPrint]);

  // QR สร้างในเบราว์เซอร์ error correction M ไม่ใช้บริการภายนอก
  const svg = useMemo(() => {
    if (!slip) return "";
    const qr = qrcode(0, "M");
    qr.addData(slip.qrUrl);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [slip]);

  if (err) return <div className="page"><p className="error">{err}</p><Link href="/appointments">กลับหน้านัดหมาย</Link></div>;
  if (!slip) return <div className="page muted">กำลังโหลด…</div>;
  const a = slip.appointment;

  const sheet = (
    <div className="appt-slip">
      <div className="appt-slip-clinic">{slip.clinic}</div>
      <div className="appt-slip-title">ใบนัด</div>
      <div className="appt-slip-row"><span>ชื่อ-นามสกุล</span><b>{a.patient_name}</b></div>
      {a.hn && <div className="appt-slip-row"><span>HN</span><b>{a.hn}</b></div>}
      {slip.series && slip.series.length > 1 ? (
        <table className="appt-slip-series">
          <tbody>
            {slip.series.map((x) => (
              <tr key={x.id} className={x.series_done ? "done" : ""}>
                <th>{x.series_done ? "✓ " : ""}{x.series_label}</th>
                {x.series_done
                  ? <td>ฉีดแล้ว {thaiMediumDate(x.appoint_date)}</td>
                  : <td><b>{thaiMediumDate(x.appoint_date)}</b><br />{timeShort(x)} น.{x.time_mode === "slot" ? " (ตามคิว)" : ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <div className="appt-slip-date">{thaiFullDate(a.appoint_date)}</div>
          <div className="appt-slip-time">{timePhrase(a)}</div>
        </>
      )}
      {a.provider && <div className="appt-slip-row"><span>ผู้นัด</span><b>{a.provider}</b></div>}
      {a.purpose_text && <div className="appt-slip-row"><span>เหตุผลนัด</span><b>{a.purpose_text}</b></div>}
      {a.instructions && <div className="appt-slip-instructions"><span>การปฏิบัติตัว</span><b>{a.instructions}</b></div>}
      {a.note && <div className="appt-slip-row"><span>หมายเหตุ</span><b>{a.note}</b></div>}
      <div className="appt-slip-qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="appt-slip-scan">สแกนแล้วกดส่ง เพื่อรับข้อความเตือนนัดทาง LINE</div>
      <div className="appt-slip-code">#{a.link_code}</div>
      <div className="appt-slip-foot">
        โทร {slip.phone}
        {slip.address && <><br />{slip.address}</>}
        <br />หากมาไม่ได้ กรุณาแจ้งล่วงหน้า
      </div>
    </div>
  );

  return (
    <div className="page appt-print-page">
      <style>{PRINT_CSS}</style>
      <div className="row between">
        <h1>ใบนัด</h1>
        <button className="btn primary" onClick={() => window.print()}>พิมพ์ (80mm)</button>
      </div>
      {message && <div className={`appt-link-state ${sent ? "ok" : ""}`}>{message}</div>}
      <div className="appt-slip-preview">{sheet}</div>
      <div className="row">
        <Link className="btn ghost" href="/appointments">กลับหน้านัดหมาย</Link>
      </div>
      {createPortal(sheet, document.body)}
    </div>
  );
}
