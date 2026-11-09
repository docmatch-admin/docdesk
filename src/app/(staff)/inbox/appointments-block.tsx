"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DELIVERY_LABEL, deliveryState, thaiShortDate, timeShort, type Appointment } from "@/lib/appointment-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { AppointmentForm, deliveryText, draftOf, EMPTY_DRAFT, type SaveResult } from "../appointments/appointment-form";
import { Icon } from "../icons";

interface Link_ { hn: string; patient_name: string | null; phone: string | null }

/**
 * นัดครั้งต่อไปของแชทนี้ (กรณีนัดผ่านแชท) ใช้ฟอร์มเดียวกับหน้านัดหมาย
 * แชทผูก HN แล้วเติม HN ชื่อ เบอร์ให้ ยังไม่ผูกให้กรอกเอง
 */
export function AppointmentsBlock({ conversationId, contactName, blurred, isAdmin, onChanged, onMessage }: {
  conversationId: string;
  isAdmin: boolean;
  contactName: string | null;
  blurred: boolean;
  onChanged: () => void;
  onMessage: (msg: string) => void;
}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [rows, setRows] = useState<Appointment[]>([]);
  const [link, setLink] = useState<Link_ | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  // แอดมินยืนยันการจับคู่ HN: ค้นชื่อจาก iService ก่อน แล้วกดยืนยัน
  const [linking, setLinking] = useState(false);
  const [hnInput, setHnInput] = useState("");
  const [preview, setPreview] = useState<{ hn: string; name: string } | null>(null);
  const [linkErr, setLinkErr] = useState("");
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/conversations/${conversationId}/appointments`);
    if (!res.ok) return;
    const j = await res.json();
    setRows(j.appointments as Appointment[]);
    setLink(j.link as Link_ | null);
  }, [conversationId]);

  useEffect(() => {
    setRows([]); setLink(null); setCreating(false); setEditing(null); setConfirmCancel(null);
    setLinking(false); setHnInput(""); setPreview(null); setLinkErr(""); setConfirmUnlink(false);
    load();
    const ch = sb.channel(`appt-${conversationId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments", filter: `conversation_id=eq.${conversationId}` }, () => load())
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [sb, conversationId, load]);

  function saved(r: SaveResult) {
    setCreating(false);
    setEditing(null);
    onMessage(r.delivery ? `บันทึกนัดแล้ว · ${deliveryText(r.delivery)}` : "บันทึกนัดแล้ว");
    load();
    onChanged();
  }

  async function cancel(id: string) {
    setConfirmCancel(null);
    const res = await fetch(`/api/appointments/${id}/cancel`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    onMessage(res.ok ? `ยกเลิกนัดแล้ว · ${deliveryText(j.delivery)}` : j.error ?? "ยกเลิกไม่สำเร็จ");
    load();
  }

  async function checkHn(e: React.FormEvent) {
    e.preventDefault();
    setLinkErr(""); setPreview(null);
    const res = await fetch(`/api/conversations/${conversationId}/patient-link?hn=${encodeURIComponent(hnInput.trim())}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setLinkErr(j.error ?? "ค้นไม่สำเร็จ");
    setPreview(j as { hn: string; name: string });
  }

  async function confirmLink() {
    if (!preview) return;
    const res = await fetch(`/api/conversations/${conversationId}/patient-link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hn: preview.hn }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setLinkErr(j.error ?? "ผูกไม่สำเร็จ");
    setLinking(false); setPreview(null); setHnInput("");
    onMessage(`ผูกแชทกับ HN ${preview.hn} แล้ว`);
    load(); onChanged();
  }

  async function unlink() {
    setConfirmUnlink(false);
    const res = await fetch(`/api/conversations/${conversationId}/patient-link`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    onMessage(res.ok ? "ยกเลิกการผูก HN แล้ว" : j.error ?? "ยกเลิกไม่สำเร็จ");
    load(); onChanged();
  }

  const initial = { ...EMPTY_DRAFT, hn: link?.hn ?? "", patient_name: link?.patient_name ?? contactName ?? "", phone: link?.phone ?? "" };

  return (
    <section className="side-block">
      <div className="side-head">
        <h3>นัดครั้งต่อไป</h3>
        {link && <span className="chip tiny">HN {link.hn}</span>}
        {isAdmin && !link && (
          <button type="button" className="btn ghost small" aria-expanded={linking} onClick={() => setLinking(!linking)}>ผูก HN</button>
        )}
        {isAdmin && link && (
          <button type="button" className={`btn ghost small ${confirmUnlink ? "danger" : ""}`} title="ยกเลิกการผูก HN กลับไปใช้ชื่อเดิม"
            onClick={() => (confirmUnlink ? unlink() : setConfirmUnlink(true))}>{confirmUnlink ? "ยืนยันยกเลิกผูก?" : "ยกเลิกผูก"}</button>
        )}
        <button type="button" className="icon-btn" aria-label="ทำนัด" title="ทำนัด" aria-expanded={creating}
          onClick={() => setCreating(!creating)}><Icon name="plus" /></button>
      </div>
      {linking && (
        <div className="appt-link-box">
          <form className="row" onSubmit={checkHn}>
            <input style={{ flex: 1, width: "auto" }} placeholder="HN" value={hnInput} onChange={(e) => { setHnInput(e.target.value); setPreview(null); }} inputMode="numeric" />
            <button className="btn ghost small" disabled={!hnInput.trim()}>ค้นใน iService</button>
          </form>
          {preview && (
            <div className="row">
              <span className="small">ชื่อใน HIS: <b>{preview.name}</b></span>
              <button type="button" className="btn primary small" onClick={confirmLink}>ยืนยันการจับคู่</button>
            </div>
          )}
          {linkErr && <div className="error small" role="alert">{linkErr}</div>}
        </div>
      )}
      {creating && (
        <AppointmentForm compact initial={initial} conversationId={conversationId} onCancel={() => setCreating(false)} onSaved={saved} />
      )}
      {rows.length === 0 && !creating && <div className="muted small">ยังไม่มีนัด</div>}
      <div className={blurred ? "sensitive-blur" : ""}>
        {rows.map((a) => (
          <div key={a.id} className="appt-side-card">
            <div className="booking-title">{thaiShortDate(a.appoint_date)} · {timeShort(a)} น.</div>
            <div className="booking-sub">{a.purpose_text || "ไม่ระบุเหตุผล"}{a.provider ? ` · ${a.provider}` : ""} · {DELIVERY_LABEL[deliveryState(a)] || a.status}</div>
            {editing === a.id ? (
              <AppointmentForm compact showPatient={false} initial={draftOf(a)} appointmentId={a.id} onCancel={() => setEditing(null)} onSaved={saved} />
            ) : (
              <div className="icon-row">
                <button type="button" className="icon-btn" aria-label="แก้ไขนัด (แก้วันเวลาแล้วส่งข้อความนัดใหม่)" title="แก้ไขนัด (แก้วันเวลาแล้วส่งข้อความนัดใหม่)"
                  onClick={() => setEditing(a.id)}><Icon name="pencil" /></button>
                <Link className="icon-btn" aria-label="พิมพ์ใบนัด" title="พิมพ์ใบนัด" href={`/appointments/${a.id}/print?reprint=1`}><Icon name="printer" /></Link>
                <button type="button" className={`icon-btn danger ${confirmCancel === a.id ? "confirm" : ""}`}
                  aria-label={confirmCancel === a.id ? "ยืนยันยกเลิกนัด" : "ยกเลิกนัด"} title={confirmCancel === a.id ? "กดอีกครั้งเพื่อยกเลิก (ส่งข้อความแจ้งยกเลิกถึงคนไข้)" : "ยกเลิกนัด"}
                  onClick={() => (confirmCancel === a.id ? cancel(a.id) : setConfirmCancel(a.id))}>
                  <Icon name="x" />{confirmCancel === a.id && <span className="icon-btn-text">ยืนยัน</span>}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
