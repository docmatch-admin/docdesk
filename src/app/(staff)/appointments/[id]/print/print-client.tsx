"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import qrcode from "qrcode-generator";
import { slipSourceTexts, slipView, type SlipData, type SlipField, type SlipLang, type SlipTexts, type SlipView } from "@/lib/appointment-slip";

type Slip = SlipData & { qrUrl: string };

const FIELD_LABEL: Record<SlipField, string> = { purpose: "เหตุผล", instructions: "การปฏิบัติตัว", note: "หมายเหตุ", title: "ชื่อชุดนัด" };

/**
 * ใบนัดเครื่องพิมพ์ความร้อน 80mm อย่างเดียว: กระดาษยาวตามเนื้อหา ไม่มีขอบ ขาวดำล้วน
 * ซ่อนทุกอย่างในหน้าตอนพิมพ์ เหลือเฉพาะสำเนาใบนัดที่ body
 */
const PRINT_CSS = `@page { size: 80mm auto; margin: 0; }
@media print {
  html, body { width: 80mm; margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body > *:not(.appt-slip) { display: none !important; }
}`;

/**
 * ใบนัด: พิมพ์ QR + รหัสทุกใบ เปิดเป็นไทยเสมอ (รวมพิมพ์ซ้ำ)
 * กด EN ถึงจะเรียกแปล (ไม่แปลล่วงหน้า) กลับ TH แสดงต้นฉบับทันทีไม่เรียก API
 * คำแปลแก้ได้ใน preview ก่อนพิมพ์ ค่าที่แก้ใช้ครั้งถัดไป
 */
export function PrintClient({ id, message, sent, autoPrint }: { id: string; message: string; sent: boolean; autoPrint: boolean }) {
  const [slip, setSlip] = useState<Slip | null>(null);
  const [lang, setLang] = useState<SlipLang>("th");
  const [en, setEn] = useState<SlipTexts | null>(null);
  const [failed, setFailed] = useState<SlipField[]>([]);
  const [failError, setFailError] = useState("");
  const [translating, setTranslating] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [err, setErr] = useState("");
  const printed = useRef(false);

  useEffect(() => {
    fetch(`/api/appointments/${id}`).then(async (r) => {
      if (!r.ok) return setErr((await r.json().catch(() => ({}))).error ?? "โหลดนัดไม่สำเร็จ");
      setSlip((await r.json()) as Slip);
    }).catch(() => setErr("โหลดนัดไม่สำเร็จ"));
  }, [id]);

  // เพิ่งบันทึกนัดหรือกดพิมพ์ซ้ำ: เปิดหน้าพิมพ์ทันที (ไทย) รอให้ QR และฟอนต์พร้อมก่อน
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

  const view = useMemo(() => (slip ? slipView(slip, lang, lang === "en" ? en ?? {} : {}) : null), [slip, lang, en]);

  async function translate() {
    setTranslating(true);
    setSaveErr("");
    try {
      const r = await fetch(`/api/appointments/${id}/translate`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setEn((cur) => ({ ...(j.en ?? {}), ...pickEdited(cur, j.failed ?? []) }));
      setFailed((j.failed ?? []) as SlipField[]);
      setFailError(j.error ?? "");
    } catch (e) {
      // แปลไม่ได้ทั้งหมด: แสดงต้นฉบับไทย ให้แก้เองหรือลองใหม่
      setFailError(e instanceof Error ? e.message : "เรียก API แปลไม่สำเร็จ");
      setEn((cur) => cur ?? {});
      setFailed(slip ? (Object.keys(slipSourceTexts(slip)) as SlipField[]) : []);
    } finally {
      setTranslating(false);
    }
  }

  function pickLang(next: SlipLang) {
    setLang(next);
    // แปลเฉพาะตอนกด EN ครั้งแรก กดซ้ำใช้ผลเดิม
    if (next === "en" && en === null && !translating) void translate();
  }

  /** แก้คำแปลใน preview: ใช้ทันทีและเก็บเป็นค่าใน cache */
  async function editField(field: SlipField, text: string) {
    const t = text.replace(/\s+\n/g, "\n").trim();
    if (!t) return;
    setEn((cur) => ({ ...(cur ?? {}), [field]: t }));
    setFailed((f) => f.filter((x) => x !== field));
    const r = await fetch(`/api/appointments/${id}/translate`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ field, text: t }) });
    setSaveErr(r.ok ? "" : "บันทึกคำแปลที่แก้ไม่สำเร็จ (ใบนี้ยังพิมพ์ตามที่แก้ได้)");
  }

  if (err) return <div className="page"><p className="error">{err}</p><Link href="/appointments">กลับหน้านัดหมาย</Link></div>;
  if (!slip || !view) return <div className="page muted">กำลังโหลด…</div>;

  const editable = lang === "en" && !translating;
  const preview = renderSheet(view, svg, slip.linkedLine, editable ? editField : null);
  const printCopy = renderSheet(view, svg, slip.linkedLine, null);

  return (
    <div className="page appt-print-page">
      <style>{PRINT_CSS}</style>
      {/* แถบเครื่องมือเดียวด้านบน: กลับ · ชื่อ … ภาษา · พิมพ์ (ติดขอบบนเมื่อเลื่อน) */}
      <div className="appt-print-bar">
        <Link className="btn ghost appt-print-back" href="/appointments" aria-label="กลับหน้านัดหมาย">
          <span aria-hidden="true">←</span> นัดหมาย
        </Link>
        <h1 className="appt-print-title">ใบนัด <span className="muted">· {slip.appointment.patient_name}</span></h1>
        <div className="appt-print-actions">
          <div className="segmented appt-slip-lang" role="tablist" aria-label="ภาษาใบนัด">
            <button type="button" role="tab" aria-selected={lang === "th"} className={lang === "th" ? "on" : ""} onClick={() => pickLang("th")}>ไทย</button>
            <button type="button" role="tab" aria-selected={lang === "en"} className={lang === "en" ? "on" : ""} onClick={() => pickLang("en")}>English</button>
          </div>
          <button className="btn primary" disabled={translating} onClick={() => window.print()}>
            {translating ? "กำลังแปล…" : "พิมพ์ใบนัด"}
          </button>
        </div>
      </div>
      {message && <div className={`appt-link-state ${sent ? "ok" : ""}`}>{message}</div>}
      {lang === "en" && translating && (
        <div className="appt-translate-state" role="status"><span className="spinner" aria-hidden="true" /> กำลังแปลเหตุผล การปฏิบัติตัว และหมายเหตุ…</div>
      )}
      {lang === "en" && !translating && failed.length > 0 && (
        <div className="appt-translate-state warn" role="alert">
          แปลไม่สำเร็จ: {failed.map((f) => FIELD_LABEL[f]).join(", ")} — ใบนี้แสดงต้นฉบับไทย แก้ข้อความในใบได้เลย หรือ
          <button type="button" className="btn ghost small" onClick={() => void translate()}>ลองใหม่</button>
          {failError && <div className="appt-translate-error"><code>{failError}</code></div>}
        </div>
      )}
      {lang === "en" && !translating && failed.length === 0 && view.rows.some((r) => r.field) && (
        <div className="appt-translate-state muted small">แปลอัตโนมัติ — คลิกข้อความที่ขีดเส้นประในใบเพื่อแก้ก่อนพิมพ์</div>
      )}
      {saveErr && <div className="error small" role="alert">{saveErr}</div>}
      <div className={`appt-slip-preview ${translating ? "busy" : ""}`}>{preview}</div>
      {createPortal(printCopy, document.body)}
    </div>
  );
}

/** ตอนลองแปลใหม่: คงคำที่พนักงานแก้ไว้แล้วของช่องที่ยังแปลไม่ได้ */
function pickEdited(cur: SlipTexts | null, failed: SlipField[]): SlipTexts {
  if (!cur) return {};
  return Object.fromEntries(failed.filter((f) => cur[f]).map((f) => [f, cur[f]]));
}

/** ข้อความแปลได้: แก้ inline ใน preview (contentEditable) บันทึกตอนออกจากช่อง */
function Editable({ field, value, onEdit }: { field?: SlipField; value: string; onEdit: ((f: SlipField, t: string) => void) | null }) {
  if (!field || !onEdit) return <>{value}</>;
  return (
    <span className="appt-slip-edit" contentEditable suppressContentEditableWarning role="textbox" aria-label={`แก้คำแปล ${FIELD_LABEL[field]}`}
      key={value} onBlur={(e) => { const t = e.currentTarget.innerText.trim(); if (t && t !== value.trim()) onEdit(field, t); }}>{value}</span>
  );
}

function renderSheet(view: SlipView, svg: string, linked: boolean, onEdit: ((f: SlipField, t: string) => void) | null) {
  return (
    <div className="appt-slip" lang={view.lang}>
      <div className="appt-slip-head">
        <div className="appt-slip-clinic">{view.clinicName}</div>
        {view.clinicAddress && <div className="appt-slip-address">{view.clinicAddress}</div>}
        {view.clinicPhone && <div className="appt-slip-phone">{view.clinicPhone}</div>}
      </div>
      <hr className="appt-slip-hr" />
      <div className="appt-slip-title"><Editable field={view.titleEditable ? "title" : undefined} value={view.title} onEdit={onEdit} /></div>
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
      {view.rows.map((r) => (
        <div key={r.label} className="appt-slip-row"><span>{r.label}</span><b><Editable field={r.field} value={r.value} onEdit={onEdit} /></b></div>
      ))}
      <hr className="appt-slip-hr" />
      {view.qr.above.map((t) => <div key={t} className="appt-slip-qr-text">{t}</div>)}
      <div className={`appt-slip-qr mm${view.qr.sizeMm}`} dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="appt-slip-code">{view.code}</div>
      {view.qr.below.map((t) => <div key={t} className={`appt-slip-qr-text ${linked ? "small" : ""}`}>{t}</div>)}
      <hr className="appt-slip-hr" />
      <div className="appt-slip-foot">
        <div>{view.footer[0]}</div>
        <div className="issued">{view.footer[1]}</div>
      </div>
    </div>
  );
}
