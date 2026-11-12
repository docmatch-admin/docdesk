"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addDays, bangkokToday, deliveryState, DELIVERY_LABEL, STATUS_LABEL, thaiMediumDate, thaiShortDate, timeShort,
  type Appointment,
} from "@/lib/appointment-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { Icon } from "../icons";
import { shortHn } from "./new-appointment";

type Row = Appointment & { series_total: number | null };
type Counts = { mustCall: number; reschedule: number; total: number };

const DAYS = 14;
const DOW = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const dow = (date: string) => DOW[new Date(`${date}T12:00:00+07:00`).getDay()];

/**
 * หน้านัดหมายบนมือถือ (≤ 899px): แถบวัน 14 วัน · การ์ดสรุป ต้องโทร/ขอเลื่อน/มาแล้ว · รายการแยกตามช่วงเวลา
 * จอใหญ่ใช้ตารางเดิม (แสดงอย่างใดอย่างหนึ่งด้วย CSS)
 */
export function AppointmentsMobile({ counts, onCreate, onOpen, onCalled }: {
  counts: Counts;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onCalled: (id: string, called: boolean) => Promise<void>;
}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const today = bangkokToday();
  const [day, setDay] = useState(today);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Row[] | null>(null);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ tab: "all", from: today, to: addDays(today, DAYS - 1) });
    const res = await fetch(`/api/appointments?${p}`);
    if (res.ok) setRows(((await res.json()).rows ?? []) as Row[]);
  }, [today]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const ch = sb.channel("appointments-mobile")
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments" }, () => load())
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [sb, load]);

  useEffect(() => {
    if (!q.trim()) { setFound(null); return; }
    const t = setTimeout(async () => {
      const res = await fetch(`/api/appointments?${new URLSearchParams({ tab: "all", q: q.trim() })}`);
      if (res.ok) setFound(((await res.json()).rows ?? []) as Row[]);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const byDay = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows ?? []) m.set(r.appoint_date, [...(m.get(r.appoint_date) ?? []), r]);
    return m;
  }, [rows]);
  const days = Array.from({ length: DAYS }, (_, i) => addDays(today, i));
  const list = [...(byDay.get(day) ?? [])].sort((a, b) => a.time_start.localeCompare(b.time_start));
  const arrived = list.filter((r) => r.status === "attended").length;
  const active = list.filter((r) => r.status !== "no_show").length;

  // กลุ่มตามช่วงเวลา (นัดแบบระบุเวลาแสดงเวลาที่แถวเอง)
  const groups: { label: string; rows: Row[] }[] = [];
  for (const r of list) {
    const label = r.time_mode === "slot" ? timeShort(r) : "ระบุเวลา";
    const g = groups.find((x) => x.label === label);
    if (g) g.rows.push(r); else groups.push({ label, rows: [r] });
  }

  return (
    <div className="appt-m">
      <div className="appt-m-head">
        <h1>นัดหมาย</h1>
        <button type="button" className="appt-m-icon" aria-label={searching ? "ปิดค้นหา" : "ค้นหานัด"} aria-pressed={searching}
          onClick={() => { setSearching(!searching); setQ(""); }}>
          <Icon name={searching ? "x" : "search"} size={20} />
        </button>
        <button type="button" className="appt-m-add" aria-label="ทำนัดใหม่" onClick={onCreate}><Icon name="plus" size={22} /></button>
      </div>

      {searching ? (
        <>
          <label className="appt-m-search">
            <Icon name="search" size={18} />
            <input autoFocus type="search" aria-label="ค้นหานัด" placeholder="ชื่อ / HN / เบอร์" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="appt-m-list">
            {found && !found.length && <div className="appt-m-empty">ไม่พบนัด</div>}
            {found?.map((r) => <MRow key={r.id} r={r} showDate onOpen={onOpen} onCalled={onCalled} />)}
          </div>
        </>
      ) : (
        <>
          <div className="appt-m-days" role="tablist" aria-label="เลือกวัน">
            {days.map((d) => {
              const n = (byDay.get(d) ?? []).filter((r) => r.status !== "cancelled").length;
              return (
                <button key={d} type="button" role="tab" aria-selected={d === day} className={d === day ? "on" : ""} onClick={() => setDay(d)}
                  aria-label={`${thaiMediumDate(d)} ${n} นัด`}>
                  <span className="d-dow">{d === today ? "วันนี้" : dow(d)}</span>
                  <span className="d-num">{Number(d.slice(8, 10))}</span>
                  <span className="d-count">{n ? `${n} นัด` : "–"}</span>
                </button>
              );
            })}
          </div>

          <div className="appt-m-sum">
            <div className="sum call"><span>ต้องโทร</span><b>{counts.mustCall}</b></div>
            <div className="sum warn"><span>ขอเลื่อน</span><b>{counts.reschedule}</b></div>
            <div className="sum ok"><span>มาแล้ว</span><b>{arrived}/{active}</b></div>
          </div>

          <div className="appt-m-list">
            {rows === null && <div className="appt-m-empty">กำลังโหลด…</div>}
            {rows && !list.length && (
              <div className="appt-m-empty">
                ไม่มีนัด{day === today ? "วันนี้" : `วัน${thaiShortDate(day)}`}
                <button type="button" className="btn outline small" onClick={onCreate}>+ ทำนัดใหม่</button>
              </div>
            )}
            {groups.map((g) => (
              <section key={g.label}>
                <h2 className="appt-m-slot">{g.label}</h2>
                {g.rows.map((r) => <MRow key={r.id} r={r} onOpen={onOpen} onCalled={onCalled} />)}
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MRow({ r, showDate, onOpen, onCalled }: { r: Row; showDate?: boolean; onOpen: (id: string) => void; onCalled: (id: string, called: boolean) => Promise<void> }) {
  const state = deliveryState(r);
  const mustCall = (state === "failed" || state === "no_chat" || state === "reschedule") && !r.called_at;
  const tel = r.phone?.replace(/[^\d+]/g, "");
  const label = r.status === "attended"
    ? `มาแล้ว${r.arrived_time ? ` ${r.arrived_time}` : ""}`
    : state === "closed" ? STATUS_LABEL[r.status] : state === "failed" || state === "no_chat" ? "ต้องโทร" : DELIVERY_LABEL[state];
  const tone = r.status === "attended" ? "done" : state === "confirmed" ? "ok" : state === "reschedule" ? "warn" : state === "failed" || state === "no_chat" ? "bad" : "";
  const sub = [
    showDate ? thaiShortDate(r.appoint_date) : null,
    r.time_mode === "exact" || showDate ? timeShort(r) : null,
    r.purpose_text,
    r.series_id && r.series_total ? `${r.series_label ?? "นัด"} ${r.series_seq}/${r.series_total}` : null,
    r.hn ? `HN ${shortHn(r.hn)}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className={`appt-m-row ${r.status === "attended" || r.status === "cancelled" ? (r.status === "attended" ? "arrived" : "faded done") : ""}`}>
      <button type="button" className="appt-m-main" onClick={() => onOpen(r.id)} aria-label={`ดูรายละเอียดนัด ${r.patient_name}`}>
        <span className="appt-m-name">{r.status === "attended" && <span className="appt-done-mark" aria-hidden="true">✓ </span>}{r.patient_name}</span>
        <span className="appt-m-sub">{sub}</span>
      </button>
      {mustCall && tel ? (
        <>
          <a className="appt-m-call" href={`tel:${tel}`} aria-label={`โทรหา ${r.patient_name}`}><Icon name="phone" size={16} />โทร</a>
          <button type="button" className="appt-m-called" aria-label={`ติ๊กว่าโทรหา ${r.patient_name} แล้ว`} title="โทรแล้ว" onClick={() => onCalled(r.id, true)}>
            <Icon name="check" size={16} />
          </button>
        </>
      ) : (
        label && <span className={`appt-m-state ${tone}`}>{r.called_at && mustCall === false && (state === "failed" || state === "no_chat") ? "โทรแล้ว" : label}</span>
      )}
    </div>
  );
}
