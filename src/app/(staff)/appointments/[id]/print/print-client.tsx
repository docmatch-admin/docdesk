"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import qrcode from "qrcode-generator";
import { slipView, type SlipData, type SlipLang } from "@/lib/appointment-slip";

type Slip = SlipData & { qrUrl: string; defaultLang: SlipLang };

/**
 * ใบนัดเครื่องพิมพ์ความร้อน 80mm อย่างเดียว: กระดาษยาวตามเนื้อหา ไม่มีขอบ ขาวดำล้วน
 * ซ่อนทุกอย่างในหน้าตอนพิมพ์ เหลือเฉพาะสำเนาใบนัดที่ body
 */
const PRINT_CSS = `@page { size: 80mm auto; margin: 0; }
@media print {
  html, body { width: 80mm; margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body > *:not(.appt-slip) { display: none !important; }
}`;

/** ใบนัด: พิมพ์ QR + รหัสทุกใบ เลือกภาษา ไทย/English ตอนพิมพ์ (ไม่ปนกันในใบเดียว) */
export function PrintClient({ id, message, sent, autoPrint }: { id: string; message: string; sent: boolean; autoPrint: boolean }) {
  const [slip, setSlip] = useState<Slip | null>(null);
  const [lang, setLang] = useState<SlipLang>("th");
  const [err, setErr] = useState("");
  const printed = useRef(false);

  useEffect(() => {
    fetch(`/api/appointments/${id}`).then(async (r) => {
      if (!r.ok) return setErr((await r.json().catch(() => ({}))).error ?? "โหลดนัดไม่สำเร็จ");
      const j = (await r.json()) as Slip;
      setSlip(j);
      setLang(j.defaultLang === "en" ? "en" : "th");
    }).catch(() => setErr("โหลดนัดไม่สำเร็จ"));
  }, [id]);

  // เพิ่งบันทึกนัดหรือกดพิมพ์ซ้ำ: เปิดหน้าพิมพ์ทันที (ภาษาเริ่มต้น) รอให้ QR และฟอนต์พร้อมก่อน
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

  const view = useMemo(() => (slip ? slipView(slip, lang) : null), [slip, lang]);

  // จำภาษาที่เลือกล่าสุดต่อคนไข้
  function pickLang(next: SlipLang) {
    setLang(next);
    fetch(`/api/appointments/${id}/slip-lang`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lang: next }) }).catch(() => {});
  }

  if (err) return <div className="page"><p className="error">{err}</p><Link href="/appointments">กลับหน้านัดหมาย</Link></div>;
  if (!slip || !view) return <div className="page muted">กำลังโหลด…</div>;

  const sheet = (
    <div className="appt-slip" lang={view.lang}>
      <div className="appt-slip-head">
        <div className="appt-slip-clinic">{view.clinicName}</div>
        {view.clinicAddress && <div className="appt-slip-address">{view.clinicAddress}</div>}
        {view.clinicPhone && <div className="appt-slip-phone">{view.clinicPhone}</div>}
      </div>
      <hr className="appt-slip-hr" />
      <div className="appt-slip-title">{view.title}</div>
      <hr className="appt-slip-hr" />
      <div className="appt-slip-row"><span>{view.name.label}</span><b>{view.name.value}</b></div>
      {view.hn && <div className="appt-slip-row"><span>{view.hn.label}</span><b>{view.hn.value}</b></div>}
      <div className="appt-slip-date">{view.date}</div>
      <div className="appt-slip-time">{view.time}</div>
      {view.queueNote && <div className="appt-slip-queue">{view.queueNote}</div>}
      {view.series && (
        <>
          <hr className="appt-slip-hr" />
          <table className="appt-slip-series">
            <tbody>
              {view.series.map((x, i) => (
                <tr key={i} className={x.current ? "current" : x.done ? "done" : ""}>
                  <th>{x.label}</th>
                  <td>{x.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.seriesNote && <div className="appt-slip-series-note">{view.seriesNote}</div>}
        </>
      )}
      {view.rows.length > 0 && <hr className="appt-slip-hr" />}
      {view.rows.map((r) => <div key={r.label} className="appt-slip-row"><span>{r.label}</span><b>{r.value}</b></div>)}
      <hr className="appt-slip-hr" />
      {view.qr.above.map((t) => <div key={t} className="appt-slip-qr-text">{t}</div>)}
      <div className={`appt-slip-qr mm${view.qr.sizeMm}`} dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="appt-slip-code">{view.code}</div>
      {view.qr.below.map((t) => <div key={t} className={`appt-slip-qr-text ${slip.linkedLine ? "small" : ""}`}>{t}</div>)}
      <hr className="appt-slip-hr" />
      <div className="appt-slip-foot">
        <div>{view.footer[0]}</div>
        <div className="issued">{view.footer[1]}</div>
      </div>
    </div>
  );

  return (
    <div className="page appt-print-page">
      <style>{PRINT_CSS}</style>
      <div className="row between">
        <h1>ใบนัด</h1>
        <div className="row">
          <div className="segmented appt-slip-lang" role="tablist" aria-label="ภาษาใบนัด">
            <button type="button" role="tab" aria-selected={lang === "th"} className={lang === "th" ? "on" : ""} onClick={() => pickLang("th")}>ไทย</button>
            <button type="button" role="tab" aria-selected={lang === "en"} className={lang === "en" ? "on" : ""} onClick={() => pickLang("en")}>English</button>
          </div>
          <button className="btn primary" onClick={() => window.print()}>พิมพ์ (80mm)</button>
        </div>
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
