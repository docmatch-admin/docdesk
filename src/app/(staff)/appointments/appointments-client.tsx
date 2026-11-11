"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DELIVERY_LABEL, deliveryState, STATUS_LABEL, thaiShortDate, timeShort,
  type Appointment, type DeliveryState,
} from "@/lib/appointment-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";
import type { ChannelType } from "@/lib/types";
import { Icon } from "../icons";
import { AppointmentDrawer } from "./appointment-drawer";
import { channelName } from "./appointment-form";
import { shortHn } from "./new-appointment";
import { NewAppointment } from "./new-appointment";

type Row = Appointment & { channel: ChannelType | null; chat_name: string | null; series_total: number | null };
type Tab = "tomorrow" | "today" | "all";

const SLOT_LABEL: Record<string, string> = { morning: "ช่วงเช้า", afternoon: "ช่วงบ่าย" };
const slotLabel = (r: Row) => SLOT_LABEL[r.slot_id ?? ""] ?? "ช่วง";

// เรียงตามเวลา: วันนี้ → พรุ่งนี้ → ทั้งหมด
const TABS: [Tab, string][] = [["today", "วันนี้"], ["tomorrow", "พรุ่งนี้"], ["all", "ทั้งหมด"]];
const STATE_CLASS: Record<DeliveryState, string> = {
  reschedule: "appt-state reschedule", confirmed: "appt-state confirmed", failed: "appt-state call", no_chat: "appt-state call",
  sent: "appt-state sent", pending: "appt-state", closed: "appt-state",
};

export function AppointmentsClient({ canOpenChat, isAdmin }: { canOpenChat: boolean; isAdmin: boolean }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [tab, setTab] = useState<Tab>("tomorrow");
  const [q, setQ] = useState("");
  // ว่าง = ไม่กรองวันที่ (แท็บทั้งหมดแสดงทุกนัด ใหม่สุดก่อน)
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [purpose, setPurpose] = useState("");
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState({ mustCall: 0, reschedule: 0, total: 0 });
  const [tabCounts, setTabCounts] = useState<Record<Tab, number> | null>(null);
  const [limit, setLimit] = useState(500);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [withCancelled, setWithCancelled] = useState(false);
  const [toast, setToast] = useState("");

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 4000); };

  const load = useCallback(async () => {
    // ส่งตัวกรองทั้งหมดเสมอ badge ของแท็บทั้งหมดจะตรงกับที่เห็นเมื่อกดเข้าไป (q/วัน/สถานะ มีผลเฉพาะแท็บทั้งหมด)
    const p = new URLSearchParams({ tab });
    if (purpose) p.set("purpose", purpose);
    if (status) p.set("status", status);
    if (withCancelled) p.set("include_cancelled", "1");
    if (q.trim()) p.set("q", q.trim());
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    const res = await fetch(`/api/appointments?${p}`);
    if (!res.ok) return;
    const j = await res.json();
    setRows(j.rows as Row[]);
    setCounts(j.counts);
    if (j.tabCounts) setTabCounts(j.tabCounts);
    if (j.limit) setLimit(j.limit);
  }, [tab, q, from, to, purpose, status, withCancelled]);

  const filtered = !!purpose || (tab === "all" && (!!q.trim() || !!from || !!to || !!status || withCancelled));
  const clearFilters = () => { setPurpose(""); setQ(""); setFrom(""); setTo(""); setStatus(""); setWithCancelled(false); };
  const shownTotal = tabCounts?.[tab] ?? rows.length;

  useEffect(() => {
    fetch("/api/appointments/form-data").then((r) => (r.ok ? r.json() : null)).then((j) => j && setPresets(j.presets)).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  // คนไข้กดยืนยัน/ขอเลื่อน หรือเจ้าหน้าที่คนอื่นติ๊กโทรแล้ว เห็นทันที
  useEffect(() => {
    const ch = sb.channel("appointments-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments" }, () => load())
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [sb, load]);

  async function patch(id: string, body: unknown) {
    const res = await fetch(`/api/appointments/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) flash((await res.json().catch(() => ({}))).error ?? "บันทึกไม่สำเร็จ");
    load();
  }

  return (
    <div className="page appt-page">
      <header className="appt-header">
        <div className="appt-title">
          <h1>นัดหมาย</h1>
          {counts.mustCall > 0 && <span className="chip red">ต้องโทร {counts.mustCall}</span>}
          {counts.reschedule > 0 && <span className="chip orange">ขอเลื่อน {counts.reschedule}</span>}
        </div>
        <div className="appt-actions-top">
          {canOpenChat && <Link className="btn outline" href="/bookings">นัดที่ AI รับไว้</Link>}
          <button className="btn primary" onClick={() => setCreating(true)} disabled={creating}>+ ทำนัดใหม่</button>
        </div>
      </header>

      {creating && <NewAppointment onClose={() => setCreating(false)} />}
      {isAdmin && <HnMatches onChanged={load} onMessage={flash} />}

      <section className="card appt-list-card">
        <div className="appt-toolbar">
          <div className="segmented" role="tablist" aria-label="ช่วงวันนัด">
            {TABS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {label}{tabCounts && <span className="seg-badge">{tabCounts[k]}</span>}
              </button>
            ))}
          </div>
          <select className="appt-purpose-filter" aria-label="กรองตามเหตุผลนัด" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="">ทุกเหตุผลนัด</option>
            {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="none">ไม่ได้เลือก preset</option>
          </select>
          {tab === "all" && (
            <div className="appt-filters">
              <label className="search-box">
                <Icon name="search" size={16} />
                <input type="search" aria-label="ค้นหานัด" placeholder="ชื่อ / HN / เบอร์" value={q} onChange={(e) => setQ(e.target.value)} />
              </label>
              <label className="raw small">ตั้งแต่<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="raw small">ถึง<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
              <select aria-label="กรองตามสถานะ" className="appt-purpose-filter" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">ทุกสถานะ (รวมมาแล้ว/ไม่มา)</option>
                {(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
              </select>
              <label className="raw small" title="นัดที่ยกเลิกซ่อนอยู่ ลบถาวรเมื่อเลยวันนัดตามระยะเก็บ (ตั้งค่า → ทีมและระบบ)">
                <input type="checkbox" checked={withCancelled || status === "cancelled"} disabled={status === "cancelled"} onChange={(e) => setWithCancelled(e.target.checked)} /> รวมยกเลิก
              </label>
            </div>
          )}
        </div>
        {filtered && rows.length > 0 && (
          <div className="appt-filter-note small muted">กรองอยู่ · พบ {shownTotal.toLocaleString("th-TH")} นัด <button type="button" className="link-btn" onClick={clearFilters}>ล้างตัวกรอง</button></div>
        )}
        {rows.length === 0 && (
          <div className="appt-empty-state">
            <Icon name="calendar" size={32} />
            {filtered ? (
              <>
                <p>ไม่พบนัดตามเงื่อนไข · <button type="button" className="link-btn" onClick={clearFilters}>ล้างตัวกรอง</button></p>
                <button className="btn outline" onClick={clearFilters}>ล้างตัวกรองทั้งหมด</button>
              </>
            ) : (
              <>
                <p>{tab === "tomorrow" ? "ยังไม่มีนัดพรุ่งนี้" : tab === "today" ? "ยังไม่มีนัดวันนี้" : "ยังไม่มีนัด"}</p>
                {!creating && <button className="btn primary" onClick={() => setCreating(true)}>+ ทำนัดใหม่</button>}
              </>
            )}
          </div>
        )}
        {rows.length > 0 && shownTotal > rows.length && (
          <div className="small muted">แสดง {rows.length.toLocaleString("th-TH")} รายการแรกจาก {shownTotal.toLocaleString("th-TH")} (ครั้งละไม่เกิน {limit}) — ตั้งช่วงวันที่เพื่อดูส่วนที่เหลือ</div>
        )}
        {rows.length > 0 && (
          <div className="report-table-wrap">
            <table className="report-table appt-table">
              <thead>
                <tr>
                  {tab === "all" && <th scope="col">วัน</th>}
                  <th scope="col">เวลา</th><th scope="col">ชื่อ</th><th scope="col">HN</th><th scope="col">เบอร์</th>
                  <th scope="col">ช่องทาง</th><th scope="col">สถานะ</th><th scope="col">โทรแล้ว</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const state = deliveryState(r);
                  const open = state !== "closed";
                  return (
                    <tr key={r.id} className={`appt-row ${open ? "" : "appt-closed"} ${r.status === "cancelled" ? "appt-cancelled" : ""} ${openId === r.id ? "selected" : ""}`}
                      onClick={() => setOpenId(r.id)} tabIndex={0} aria-label={`ดูรายละเอียดนัด ${r.patient_name}`}
                      onKeyDown={(e) => { if (e.key === "Enter") setOpenId(r.id); }}>
                      {tab === "all" && <td>{thaiShortDate(r.appoint_date)}</td>}
                      <td>{r.time_mode === "slot" ? <>{slotLabel(r)}<div className="muted small">{timeShort(r)}</div></> : timeShort(r)}</td>
                      <td>
                        {r.patient_name}
                        {r.series_id && r.series_total && <span className="chip tiny appt-series-chip">{r.series_label ?? "นัด"} {r.series_seq}/{r.series_total}</span>}
                        {r.purpose_text && <div className="muted small">{r.purpose_text}</div>}
                      </td>
                      <td className="appt-hn">{r.hn ? shortHn(r.hn) : "–"}</td>
                      <td>{r.phone ? <a href={`tel:${r.phone.replace(/[^\d+]/g, "")}`} onClick={(e) => e.stopPropagation()}>{r.phone}</a> : "–"}</td>
                      <td>
                        {r.channel ? <span className={`chip ch-${r.channel}`}>{channelName(r.channel)}</span> : <span className="muted small">ไม่มีแชท</span>}
                        {r.chat_name && <div className="name-platform">{r.chat_name}</div>}
                      </td>
                      <td>
                        <span className={state === "closed" ? `appt-state closed status-${r.status}` : STATE_CLASS[state]} title={r.last_send_error ?? undefined}>{state === "closed" ? STATUS_LABEL[r.status] : DELIVERY_LABEL[state]}</span>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label={`โทรหา ${r.patient_name} แล้ว`} checked={!!r.called_at} disabled={!open}
                          onChange={(e) => patch(r.id, { called: e.target.checked })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {openId && (
        <AppointmentDrawer id={openId} canOpenChat={canOpenChat} isAdmin={isAdmin} onClose={() => setOpenId(null)}
          onChanged={(m) => { if (m) flash(m); load(); }} />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

interface HnMatch {
  id: string; hn: string; his_name: string | null; matched_by: "name" | "name_phone";
  appointment: { id: string; patient_name: string; phone: string | null; appoint_date: string; conversation_id: string | null } | null;
}

/** คนไข้ใหม่ที่นัดจากแชทมาตรวจแล้ว ระบบเจอ visit ที่ชื่อตรง ให้แอดมินยืนยันผูก HN */
function HnMatches({ onChanged, onMessage }: { onChanged: () => void; onMessage: (m: string) => void }) {
  const [rows, setRows] = useState<HnMatch[]>([]);
  const load = useCallback(async () => {
    const r = await fetch("/api/appointments/hn-matches");
    if (r.ok) setRows((await r.json()).matches as HnMatch[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function decide(id: string, accept: boolean) {
    const r = await fetch(`/api/appointments/hn-matches/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accept }) });
    const j = await r.json().catch(() => ({}));
    onMessage(r.ok ? (accept ? "ผูก HN กับแชทแล้ว · นัดเป็นมาตามนัด" : "ปฏิเสธการจับคู่แล้ว") : j.error ?? "บันทึกไม่สำเร็จ");
    load();
    onChanged();
  }

  if (!rows.length) return null;
  return (
    <section className="card appt-matches">
      <h3>รอยืนยันการจับคู่ HN ({rows.length})</h3>
      <p className="muted small">คนไข้ใหม่ที่นัดจากแชทมาตรวจแล้ว ระบบพบ visit ที่ชื่อตรงกัน ยืนยันแล้วแชทจะแสดงชื่อจริง · HN และนัดเป็น "มาตามนัด"</p>
      {rows.map((m) => (
        <div key={m.id} className="appt-match-row">
          <div className="appt-match-info">
            <b>{m.appointment?.patient_name ?? "–"}</b>
            <span className="muted small">{m.appointment?.phone ?? "ไม่มีเบอร์"} · นัด {m.appointment ? thaiShortDate(m.appointment.appoint_date) : "–"}</span>
          </div>
          <span className="appt-match-arrow" aria-hidden="true">→</span>
          <div className="appt-match-info">
            <b>{m.his_name ?? "–"}</b>
            <span className="muted small">HN {shortHn(m.hn)} · {m.matched_by === "name_phone" ? "ชื่อและเบอร์ตรง" : "ชื่อตรง (เบอร์ยังไม่ยืนยัน)"}</span>
          </div>
          <div className="appt-match-actions">
            <button className="btn primary small" onClick={() => decide(m.id, true)}>ยืนยันผูก HN</button>
            <button className="btn ghost small" onClick={() => decide(m.id, false)}>ไม่ใช่คนนี้</button>
          </div>
        </div>
      ))}
    </section>
  );
}
