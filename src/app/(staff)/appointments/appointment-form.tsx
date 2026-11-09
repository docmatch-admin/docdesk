"use client";

import { useEffect, useMemo, useState } from "react";
import {
  bangkokToday, DEFAULT_TIME_SLOTS, quickDates, thaiClock, thaiFullDate,
  type Appointment,
} from "@/lib/appointment-rules";
import type { ChannelType } from "@/lib/types";

export interface AppointmentDraft {
  hn: string;
  patient_name: string;
  phone: string;
  appoint_date: string;
  appoint_time: string;
  purpose: string;
  provider: string;
  note: string;
}

export const EMPTY_DRAFT: AppointmentDraft = { hn: "", patient_name: "", phone: "", appoint_date: "", appoint_time: "", purpose: "", provider: "", note: "" };

export const draftOf = (a: Appointment): AppointmentDraft => ({
  hn: a.hn ?? "", patient_name: a.patient_name, phone: a.phone ?? "", appoint_date: a.appoint_date, appoint_time: a.appoint_time.slice(0, 5),
  purpose: a.purpose ?? "", provider: a.provider ?? "", note: a.note ?? "",
});

export interface DeliveryResult { sent: boolean; via?: ChannelType; error?: string }
export interface SaveResult { appointment: Appointment; delivery: DeliveryResult | null }

interface FormData {
  purposes: string[];
  providers: string[];
  times: string[];
  linked: { conversation_id: string; channel: ChannelType | null } | null;
  closedDays: number[];
}

const CHANNEL_NAME: Record<string, string> = { line: "LINE", facebook: "Facebook", instagram: "Instagram", web: "แชทหน้าเว็บ" };
export const channelName = (c: string | null | undefined) => (c ? CHANNEL_NAME[c] ?? c : "");

/** ข้อความผลการส่งหลังบันทึก */
export function deliveryText(d: DeliveryResult | null | undefined): string {
  if (!d) return "";
  if (d.sent) return `ส่งข้อความนัดทาง ${channelName(d.via)} แล้ว`;
  return d.error ?? "ส่งข้อความไม่สำเร็จ";
}

const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/**
 * ฟอร์มนัดเดียวกันทั้งหน้านัดหมายและกล่องขวาของแชท
 * เน้นกดน้อย: ปุ่มลัดวัน ปุ่มเวลาที่ใช้บ่อย และ autocomplete เหตุผลนัด
 */
export function AppointmentForm({ initial, hisName, conversationId, bookingId, appointmentId, showPatient = true, compact = false, saveLabel, onSaved, onCancel }: {
  initial: AppointmentDraft;
  /** ชื่อที่ได้จาก iService ถ้าไม่ได้แก้ ระบบใช้เป็นชื่อ HIS ตอนผูกแชท */
  hisName?: string;
  conversationId?: string;
  bookingId?: string;
  /** แก้นัดเดิม */
  appointmentId?: string;
  showPatient?: boolean;
  compact?: boolean;
  saveLabel?: string;
  onSaved: (r: SaveResult) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<AppointmentDraft>(initial);
  const [data, setData] = useState<FormData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const today = bangkokToday();
  const quick = useMemo(() => quickDates(today), [today]);
  const set = (patch: Partial<AppointmentDraft>) => setForm((f) => ({ ...f, ...patch }));

  // HN เปลี่ยน → ดูว่ามีแชทแล้วหรือยัง (หน่วงไว้ไม่ให้ยิงทุกตัวอักษร)
  useEffect(() => {
    const hn = form.hn.trim();
    const t = setTimeout(() => {
      fetch(`/api/appointments/form-data${hn ? `?hn=${encodeURIComponent(hn)}` : ""}`)
        .then((r) => (r.ok ? r.json() : null)).then((d) => d && setData(d as FormData)).catch(() => {});
    }, hn ? 300 : 0);
    return () => clearTimeout(t);
  }, [form.hn]);

  const times = data?.times?.length ? data.times : DEFAULT_TIME_SLOTS;
  const closed = form.appoint_date && data?.closedDays.includes(weekdayOf(form.appoint_date));
  const willSend = !!conversationId || !!data?.linked;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.appoint_date) return setErr("เลือกวันนัด");
    if (!form.appoint_time) return setErr("เลือกเวลา");
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(appointmentId ? `/api/appointments/${appointmentId}` : "/api/appointments", {
        method: appointmentId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          ...(appointmentId ? {} : { conversation_id: conversationId, booking_id: bookingId, name_from_his: !!hisName && form.patient_name.trim() === hisName.trim() }),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return setErr(j.error ?? "บันทึกไม่สำเร็จ");
      onSaved(j as SaveResult);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`appt-form ${compact ? "compact" : ""}`} onSubmit={save}>
      {showPatient && (
        <div className="appt-grid">
          <label>HN<input value={form.hn} onChange={(e) => set({ hn: e.target.value })} inputMode="numeric" autoComplete="off" /></label>
          <label className="span2">ชื่อคนไข้<input required value={form.patient_name} onChange={(e) => set({ patient_name: e.target.value })} autoComplete="off" /></label>
          <label>เบอร์โทร<input value={form.phone} onChange={(e) => set({ phone: e.target.value })} inputMode="tel" autoComplete="off" /></label>
        </div>
      )}

      <fieldset className="appt-field">
        <legend>วันนัด</legend>
        <div className="appt-chips">
          {quick.map((q) => (
            <button type="button" key={q.label} className={`appt-chip ${form.appoint_date === q.date ? "on" : ""}`} onClick={() => set({ appoint_date: q.date })}>
              {q.label}
            </button>
          ))}
          <input type="date" aria-label="เลือกวันนัดเอง" className="appt-date" min={today} value={form.appoint_date} onChange={(e) => set({ appoint_date: e.target.value })} />
        </div>
        {form.appoint_date && (
          <div className={`appt-picked ${closed ? "warn" : ""}`}>
            {thaiFullDate(form.appoint_date)}{closed ? " — คลินิกปิดวันนี้" : ""}
          </div>
        )}
      </fieldset>

      <fieldset className="appt-field">
        <legend>เวลา</legend>
        <div className="appt-chips">
          {times.map((t) => (
            <button type="button" key={t} className={`appt-chip ${form.appoint_time === t ? "on" : ""}`} onClick={() => set({ appoint_time: t })}>
              {thaiClock(t)}
            </button>
          ))}
          <input type="time" aria-label="เลือกเวลาเอง" className="appt-time" value={form.appoint_time} onChange={(e) => set({ appoint_time: e.target.value })} />
        </div>
      </fieldset>

      <div className="appt-grid">
        <label className="span2">เหตุผลนัด
          <input list="appt-purposes" value={form.purpose} onChange={(e) => set({ purpose: e.target.value })} placeholder="เช่น ติดตามความดัน, ฟังผลเลือด" autoComplete="off" />
        </label>
        <label className="span2">ผู้นัด
          <input list="appt-providers" value={form.provider} onChange={(e) => set({ provider: e.target.value })} autoComplete="off" />
        </label>
        <label className="span4">หมายเหตุ
          <input value={form.note} onChange={(e) => set({ note: e.target.value })} placeholder="เช่น งดน้ำงดอาหารก่อนมา 8 ชม." autoComplete="off" />
        </label>
      </div>
      <datalist id="appt-purposes">{data?.purposes.map((p) => <option key={p} value={p} />)}</datalist>
      <datalist id="appt-providers">{data?.providers.map((p) => <option key={p} value={p} />)}</datalist>

      {!appointmentId && (
        <div className={`appt-link-state ${willSend ? "ok" : ""}`}>
          {conversationId ? "จะส่งข้อความนัดเข้าแชทนี้ทันทีที่บันทึก"
            : data?.linked ? `HN นี้มีแชท ${channelName(data.linked.channel)} แล้ว — จะส่งข้อความนัดทันทีที่บันทึก`
            : "ยังไม่มีแชท — ให้คนไข้สแกน QR บนใบนัด"}
        </div>
      )}
      {err && <div className="error small" role="alert">{err}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy}>{busy ? "กำลังบันทึก…" : saveLabel ?? (appointmentId ? "บันทึกการแก้ไข" : "บันทึกนัด")}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>ยกเลิก</button>
      </div>
    </form>
  );
}
