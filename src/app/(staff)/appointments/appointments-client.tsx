"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bangkokToday, DELIVERY_LABEL, deliveryState, STATUS_LABEL, thaiShortDate, timeShort,
  type Appointment, type DeliveryState,
} from "@/lib/appointment-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";
import type { ChannelType } from "@/lib/types";
import { AppointmentForm, channelName, deliveryText, draftOf } from "./appointment-form";
import { NewAppointment } from "./new-appointment";

type Row = Appointment & { channel: ChannelType | null; chat_name: string | null };
type Tab = "tomorrow" | "today" | "all";

const SLOT_LABEL: Record<string, string> = { morning: "ช่วงเช้า", afternoon: "ช่วงบ่าย" };
const slotLabel = (r: Row) => SLOT_LABEL[r.slot_id ?? ""] ?? "ช่วง";

const TABS: [Tab, string][] = [["tomorrow", "พรุ่งนี้"], ["today", "วันนี้"], ["all", "ทั้งหมด"]];
const STATE_CLASS: Record<DeliveryState, string> = {
  reschedule: "appt-state reschedule", confirmed: "appt-state confirmed", failed: "appt-state call", no_chat: "appt-state call",
  sent: "appt-state sent", pending: "appt-state", closed: "appt-state",
};

export function AppointmentsClient({ canOpenChat }: { canOpenChat: boolean }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [tab, setTab] = useState<Tab>("tomorrow");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState(bangkokToday());
  const [to, setTo] = useState("");
  const [purpose, setPurpose] = useState("");
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState({ mustCall: 0, reschedule: 0, total: 0 });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 4000); };

  const load = useCallback(async () => {
    const p = new URLSearchParams({ tab });
    if (purpose) p.set("purpose", purpose);
    if (tab === "all") {
      if (q.trim()) p.set("q", q.trim());
      if (from) p.set("from", from);
      if (to) p.set("to", to);
    }
    const res = await fetch(`/api/appointments?${p}`);
    if (!res.ok) return;
    const j = await res.json();
    setRows(j.rows as Row[]);
    setCounts(j.counts);
  }, [tab, q, from, to, purpose]);

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

  async function cancel(id: string) {
    setConfirmCancel(null);
    const res = await fetch(`/api/appointments/${id}/cancel`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) flash(j.error ?? "ยกเลิกไม่สำเร็จ");
    else flash(`ยกเลิกนัดแล้ว${j.delivery?.sent ? " · ส่งข้อความแจ้งยกเลิกแล้ว" : ""}`);
    load();
  }

  return (
    <div className="page appt-page">
      <div className="row between">
        <h1>นัดหมาย</h1>
        <div className="row">
          {counts.mustCall > 0 && <span className="chip red">ต้องโทร {counts.mustCall}</span>}
          {counts.reschedule > 0 && <span className="chip orange">ขอเลื่อน {counts.reschedule}</span>}
          {canOpenChat && <Link className="btn ghost small" href="/bookings">นัดที่ AI รับไว้</Link>}
          {!creating && <button className="btn primary" onClick={() => setCreating(true)}>+ ทำนัดใหม่</button>}
        </div>
      </div>

      {creating && <NewAppointment onClose={() => setCreating(false)} />}

      <div className="tabs wide" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
        ))}
        <select className="appt-purpose-filter" aria-label="กรองตามเหตุผลนัด" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
          <option value="">ทุกเหตุผลนัด</option>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          <option value="none">ไม่ได้เลือก preset</option>
        </select>
        {tab === "all" && (
          <div className="row appt-filters">
            <input className="search" placeholder="ค้นหา ชื่อ / HN / เบอร์" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="raw small">ตั้งแต่<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="raw small">ถึง<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
        )}
      </div>

      <section className="card">
        {rows.length === 0 && <div className="muted small">ไม่มีนัด</div>}
        {rows.length > 0 && (
          <div className="report-table-wrap">
            <table className="report-table appt-table">
              <thead>
                <tr>
                  {tab === "all" && <th scope="col">วัน</th>}
                  <th scope="col">เวลา</th><th scope="col">ชื่อ</th><th scope="col">HN</th><th scope="col">เบอร์</th>
                  <th scope="col">ช่องทาง</th><th scope="col">สถานะส่ง</th><th scope="col">โทรแล้ว</th><th scope="col"><span className="sr-only">จัดการ</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const state = deliveryState(r);
                  const open = state !== "closed";
                  return (
                    <tr key={r.id} className={open ? "" : "appt-closed"}>
                      {tab === "all" && <td>{thaiShortDate(r.appoint_date)}</td>}
                      <td>{r.time_mode === "slot" ? <>{slotLabel(r)}<div className="muted small">{timeShort(r)}</div></> : timeShort(r)}</td>
                      <td>
                        {r.patient_name}
                        {r.purpose_text && <div className="muted small">{r.purpose_text}</div>}
                        {editing === r.id && (
                          <AppointmentForm compact initial={draftOf(r)} appointmentId={r.id}
                            onCancel={() => setEditing(null)}
                            onSaved={(res) => { setEditing(null); flash(res.delivery ? `บันทึกแล้ว · ${deliveryText(res.delivery)}` : "บันทึกแล้ว"); load(); }} />
                        )}
                      </td>
                      <td>{r.hn || "–"}</td>
                      <td>{r.phone ? <a href={`tel:${r.phone.replace(/[^\d+]/g, "")}`}>{r.phone}</a> : "–"}</td>
                      <td>
                        {r.channel ? <span className={`chip ch-${r.channel}`}>{channelName(r.channel)}</span> : <span className="muted small">ไม่มีแชท</span>}
                        {r.chat_name && <div className="name-platform">{r.chat_name}</div>}
                      </td>
                      <td>
                        <span className={STATE_CLASS[state]} title={r.last_send_error ?? undefined}>{state === "closed" ? STATUS_LABEL[r.status] : DELIVERY_LABEL[state]}</span>
                      </td>
                      <td>
                        <input type="checkbox" aria-label={`โทรหา ${r.patient_name} แล้ว`} checked={!!r.called_at} disabled={!open}
                          onChange={(e) => patch(r.id, { called: e.target.checked })} />
                      </td>
                      <td className="appt-actions">
                        {canOpenChat && r.conversation_id && <Link className="btn ghost small" href={`/inbox?c=${r.conversation_id}`}>แชท</Link>}
                        <Link className="btn ghost small" href={`/appointments/${r.id}/print?reprint=1`}>พิมพ์ซ้ำ</Link>
                        {open && editing !== r.id && <button className="btn ghost small" onClick={() => setEditing(r.id)}>แก้ไข</button>}
                        {open && (
                          <button className={`btn ghost small ${confirmCancel === r.id ? "danger" : ""}`}
                            onClick={() => (confirmCancel === r.id ? cancel(r.id) : setConfirmCancel(r.id))}>
                            {confirmCancel === r.id ? "ยืนยันยกเลิก?" : "ยกเลิก"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
