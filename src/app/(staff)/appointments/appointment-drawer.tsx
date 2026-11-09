"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  canRestore, CANCEL_REASON_LABEL, DELIVERY_LABEL, deliveryState, isEditable, STATUS_LABEL, thaiFullDate, thaiMediumDate as thaiShortDateFull, timePhrase, timeShort,
  type Appointment, type CancelReason,
} from "@/lib/appointment-rules";
import { Icon } from "../icons";
import { AppointmentForm, deliveryText, draftOf } from "./appointment-form";

interface EventRow { id: string; kind: string; actor: "staff" | "customer" | "system"; staff_name: string | null; channel: string | null; detail: Record<string, unknown>; created_at: string }
interface Detail { appointment: Appointment; events: EventRow[]; series: Appointment[] }

const EVENT_LABEL: Record<string, string> = {
  created: "ลงนัด", edited: "แก้ไขรายละเอียด", rescheduled: "เปลี่ยนวัน/เวลา", cancelled: "ยกเลิกนัด", restored: "กู้คืนนัด",
  sent: "ส่งข้อความ", send_failed: "ส่งไม่ได้", send_skipped: "ไม่ได้ส่งข้อความ", confirmed: "คนไข้กดยืนยัน",
  reschedule_requested: "คนไข้ขอเลื่อน", linked: "คนไข้สแกน QR ผูกแชท", called: "ติ๊กโทรแล้ว", call_unmarked: "เอาติ๊กโทรออก",
  attended: "มาตามนัด", no_show: "ไม่มาตามนัด", reminder_skipped: "ข้ามการเตือน", hn_match_suggested: "เสนอจับคู่ HN",
  hn_match_accepted: "ยืนยันจับคู่ HN", unlinked: "ยกเลิกการผูกแชท",
};
const KIND_LABEL: Record<string, string> = { new: "นัดใหม่", changed: "เปลี่ยนนัด", reminder: "เตือนก่อนวันนัด", cancelled: "แจ้งยกเลิก", linked: "ผูกแชท" };
/** รหัสเหตุผลการส่งไม่ได้ในประวัติ */
const REASON_LABEL: Record<string, string> = {
  no_chat: "ยังไม่มีแชท", outside_24h: "เกิน 24 ชม. (Facebook/Instagram)", web: "แชทหน้าเว็บ", archived: "แชทนำเข้า", unsupported: "ช่องทางไม่รองรับ",
};
const ACTOR_LABEL ={ staff: "เจ้าหน้าที่", customer: "คนไข้", system: "ระบบ" };
const timeTh = (iso: string) => new Date(iso).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

function eventText(e: EventRow): string {
  const d = e.detail ?? {};
  const base = EVENT_LABEL[e.kind] ?? e.kind;
  const extra = [
    typeof d.kind === "string" ? KIND_LABEL[d.kind] ?? d.kind : null,
    typeof d.from === "string" && typeof d.to === "string" ? `${d.from} → ${d.to}` : null,
    typeof d.reason === "string" ? REASON_LABEL[d.reason] ?? d.reason : null,
    e.channel ? e.channel.toUpperCase() : null,
  ].filter(Boolean);
  return extra.length ? `${base} · ${extra.join(" · ")}` : base;
}

/**
 * รายละเอียดนัดแบบ drawer ใช้ทั้งหน้านัดหมายและกล่องขวาของแชท
 * แก้ไข/ยกเลิกได้เฉพาะนัดที่ยังเปิดอยู่ มาแล้ว/ไม่มา/ยกเลิก ดูอย่างเดียว (ยกเลิกวันนี้กู้คืนได้)
 */
export function AppointmentDrawer({ id, canOpenChat, onClose, onChanged }: {
  id: string;
  canOpenChat: boolean;
  onClose: () => void;
  onChanged: (message?: string) => void;
}) {
  const [data, setData] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"view" | "edit" | "cancel">("view");
  const [reason, setReason] = useState<CancelReason | "">("");
  const [reasonText, setReasonText] = useState("");
  const [busy, setBusy] = useState(false);
  const [askPrint, setAskPrint] = useState("");
  const [scope, setScope] = useState<"one" | "series">("one");

  const load = useCallback(async () => {
    const r = await fetch(`/api/appointments/${id}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return setErr(j.error ?? "โหลดนัดไม่สำเร็จ");
    setData({ appointment: j.appointment, events: j.events, series: j.series ?? [] });
  }, [id]);

  useEffect(() => { setMode("view"); setAskPrint(""); setData(null); load(); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function cancel(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) return setErr("เลือกเหตุผลการยกเลิก");
    if (reason === "other" && !reasonText.trim()) return setErr("พิมพ์เหตุผลการยกเลิก");
    setBusy(true);
    setErr("");
    const r = await fetch(`/api/appointments/${id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason, reason_text: reasonText, scope }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setErr(j.error ?? "ยกเลิกไม่สำเร็จ");
    setMode("view");
    setReason(""); setReasonText("");
    await load();
    onChanged(`ยกเลิกนัดแล้ว${j.cancelled > 1 ? ` ${j.cancelled} นัด` : ""}${j.delivery ? ` · ${deliveryText(j.delivery)}` : " · ไม่ได้ส่งข้อความ (ลงนัดผิด)"}`);
  }

  async function restore() {
    setBusy(true);
    const r = await fetch(`/api/appointments/${id}/restore`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setErr(j.error ?? "กู้คืนไม่สำเร็จ");
    await load();
    onChanged("กู้คืนนัดแล้ว");
  }

  const a = data?.appointment;
  const editable = a ? isEditable(a) : false;
  const state = a ? deliveryState(a) : "closed";
  const series = data?.series ?? [];
  const following = a?.series_seq ? series.filter((x) => (x.series_seq ?? 0) > (a.series_seq ?? 0) && isEditable(x)).length : 0;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="รายละเอียดนัด" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>รายละเอียดนัด</h2>
          <button type="button" className="icon-btn" aria-label="ปิด" onClick={onClose}><Icon name="x" /></button>
        </header>
        {!a && !err && <div className="muted small drawer-body">กำลังโหลด…</div>}
        {err && <div className="error small drawer-err" role="alert">{err}</div>}
        {a && (
          <div className="drawer-body">
            <div className="drawer-summary">
              {a.series_id && <span className="chip tiny appt-series-chip">{a.series_label ?? "นัดในชุด"} · {a.series_seq}/{Math.max(...series.map((x) => x.series_seq ?? 0))}</span>}
              <div className={`drawer-name ${a.status === "cancelled" ? "struck" : ""}`}>{a.patient_name}{a.hn && <span className="muted small"> · HN {a.hn.replace(/^0+(?=\d)/, "")}</span>}</div>
              <div className={`drawer-when ${a.status === "cancelled" ? "struck" : ""}`}>{thaiFullDate(a.appoint_date)}</div>
              <div className="muted">{timePhrase(a)}</div>
              <div className="drawer-chips">
                <span className={`chip appt-status-${a.status}`}>{STATUS_LABEL[a.status]}</span>
                {state !== "closed" && <span className="chip">{DELIVERY_LABEL[state]}</span>}
                {a.called_at && <span className="chip">โทรแล้ว</span>}
              </div>
            </div>

            {askPrint && (
              <div className="drawer-ask" role="status">
                <span>{askPrint} · พิมพ์ใบนัดใหม่ไหม?</span>
                <Link className="btn primary small" href={`/appointments/${a.id}/print?reprint=1`}>พิมพ์ใบนัดใหม่</Link>
                <button type="button" className="btn ghost small" onClick={() => setAskPrint("")}>ไม่ต้อง</button>
              </div>
            )}

            {mode === "edit" ? (
              <AppointmentForm compact showPatient={false} initial={draftOf(a)} appointmentId={a.id} seriesFollowing={following}
                onCancel={() => setMode("view")}
                onSaved={async (r) => {
                  setMode("view");
                  await load();
                  const msg = `${r.delivery ? `บันทึกแล้ว · ${deliveryText(r.delivery)}` : "บันทึกแล้ว"}${r.shifted ? ` · เลื่อนนัดถัดไปตาม ${r.shifted} นัด` : ""}`;
                  // เปลี่ยนวันหรือเวลา: ใบนัดเดิมใช้ไม่ได้แล้ว
                  if (r.moved) setAskPrint(msg);
                  onChanged(msg);
                }} />
            ) : mode === "cancel" ? (
              <form className="drawer-cancel" onSubmit={cancel}>
                <b>เหตุผลการยกเลิก</b>
                {(Object.keys(CANCEL_REASON_LABEL) as CancelReason[]).map((k) => (
                  <label key={k} className="raw">
                    <input type="radio" name="cancel-reason" checked={reason === k} onChange={() => setReason(k)} />
                    {CANCEL_REASON_LABEL[k]}{k === "mistake" && <span className="muted small"> (ไม่ส่งข้อความแจ้งคนไข้)</span>}
                  </label>
                ))}
                {reason === "other" && <input autoFocus aria-label="เหตุผลอื่น" placeholder="พิมพ์เหตุผล" value={reasonText} onChange={(e) => setReasonText(e.target.value)} />}
                {a.series_id && (
                  <>
                    <b>ยกเลิกแค่ไหน</b>
                    <label className="raw"><input type="radio" name="cancel-scope" checked={scope === "one"} onChange={() => setScope("one")} /> เฉพาะนัดนี้ ({a.series_label})</label>
                    <label className="raw"><input type="radio" name="cancel-scope" checked={scope === "series"} onChange={() => setScope("series")} /> ทั้งชุด (นัดที่ยังไม่ถึงทั้งหมด)</label>
                  </>
                )}
                <div className="row">
                  <button className="btn danger-solid" disabled={busy || !reason}>{busy ? "กำลังยกเลิก…" : "ยืนยันยกเลิกนัด"}</button>
                  <button type="button" className="btn ghost" onClick={() => { setMode("view"); setErr(""); }}>กลับ</button>
                </div>
              </form>
            ) : (
              <>
                <dl className="drawer-dl">
                  <dt>เหตุผลนัด</dt><dd>{a.purpose_text || "–"}</dd>
                  <dt>การปฏิบัติตัว</dt><dd>{a.instructions || "–"}</dd>
                  <dt>ผู้นัด</dt><dd>{a.provider || "–"}</dd>
                  <dt>หมายเหตุ</dt><dd>{a.note || "–"}</dd>
                  <dt>เบอร์</dt><dd>{a.phone ? <a href={`tel:${a.phone.replace(/[^\d+]/g, "")}`}>{a.phone}</a> : "–"}</dd>
                  <dt>รหัสใบนัด</dt><dd><code>#{a.link_code}</code></dd>
                  {a.status === "cancelled" && <><dt>เหตุผลยกเลิก</dt><dd>{a.cancel_reason || "–"}{a.cancelled_at ? ` · ${timeTh(a.cancelled_at)}` : ""}</dd></>}
                  {a.last_send_error && <><dt>ส่งไม่ได้</dt><dd className="error">{a.last_send_error}</dd></>}
                </dl>
                <div className="drawer-actions">
                  {editable && <button type="button" className="btn primary" onClick={() => { setErr(""); setMode("edit"); }}>แก้ไข</button>}
                  {editable && <button type="button" className="btn outline danger" onClick={() => { setErr(""); setMode("cancel"); }}>ยกเลิกนัด</button>}
                  {canRestore(a) && <button type="button" className="btn outline" disabled={busy} onClick={restore}>กู้คืนนัด</button>}
                  {a.status !== "cancelled" && <Link className="btn ghost" href={`/appointments/${a.id}/print?reprint=1`}>พิมพ์ใบนัดซ้ำ</Link>}
                  {canOpenChat && a.conversation_id && <Link className="btn ghost" href={`/inbox?c=${a.conversation_id}`}>ไปที่แชท</Link>}
                </div>
                {!editable && a.status !== "cancelled" && <p className="muted small">นัดนี้{STATUS_LABEL[a.status]}แล้ว ดูได้อย่างเดียว</p>}
              </>
            )}

            {series.length > 1 && (
              <section className="drawer-series">
                <h3>นัดในชุดนี้</h3>
                <ol>
                  {series.map((x) => (
                    <li key={x.id} className={x.id === a.id ? "current" : ""}>
                      {x.series_done ? <>✓ <b>{x.series_label}</b> ฉีดแล้ว {thaiShortDateFull(x.appoint_date)}</> : (
                        <><b>{x.series_label}</b> {thaiShortDateFull(x.appoint_date)} · {timeShort(x)} น.<span className="muted small"> · {STATUS_LABEL[x.status]}</span></>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <section className="drawer-history">
              <h3>ประวัติ</h3>
              <ol>
                {[...(data?.events ?? [])].reverse().map((e) => (
                  <li key={e.id}>
                    <span className="drawer-history-text">{eventText(e)}</span>
                    <span className="muted small">{timeTh(e.created_at)} · {e.staff_name ?? ACTOR_LABEL[e.actor]}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
