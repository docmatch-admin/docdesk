"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addDays, bangkokToday, DEFAULT_CLINIC_HOURS, DEFAULT_SLOT_ID, isClosedDate, isWithinOpenHours, nextOpenDate, quickDates,
  relativeDate, slotsForDate, thaiClock, thaiFullDate,
  type Appointment, type ClinicSchedule, type DateUnit, type TimeMode,
} from "@/lib/appointment-rules";
import type { ChannelType } from "@/lib/types";
import { MonthCalendar, type DayCounts } from "./month-calendar";

export interface AppointmentDraft {
  hn: string;
  patient_name: string;
  phone: string;
  appoint_date: string;
  time_mode: TimeMode;
  slot_id: string;
  time_start: string;
  purpose_id: string;
  purpose_text: string;
  instructions: string;
  provider: string;
  note: string;
}

export const EMPTY_DRAFT: AppointmentDraft = {
  hn: "", patient_name: "", phone: "", appoint_date: "", time_mode: "slot", slot_id: DEFAULT_SLOT_ID, time_start: "",
  purpose_id: "", purpose_text: "", instructions: "", provider: "", note: "",
};

export const draftOf = (a: Appointment): AppointmentDraft => ({
  hn: a.hn ?? "", patient_name: a.patient_name, phone: a.phone ?? "", appoint_date: a.appoint_date,
  time_mode: a.time_mode, slot_id: a.slot_id ?? DEFAULT_SLOT_ID, time_start: a.time_start.slice(0, 5),
  purpose_id: a.purpose_id ?? "", purpose_text: a.purpose_text ?? "", instructions: a.instructions ?? "",
  provider: a.provider ?? "", note: a.note ?? "",
});

export interface DeliveryResult { sent: boolean; via?: ChannelType; error?: string }
export interface SaveResult { appointment: Appointment; delivery: DeliveryResult | null }

export interface PurposePreset { id: string; name: string; default_days: number | null; reminder_extra_text: string | null }

interface FormData {
  presets: PurposePreset[];
  purposeHistory: string[];
  providers: string[];
  linked: { conversation_id: string; channel: ChannelType | null } | null;
  schedule: ClinicSchedule;
}

const CHANNEL_NAME: Record<string, string> = { line: "LINE", facebook: "Facebook", instagram: "Instagram", web: "แชทหน้าเว็บ" };
export const channelName = (c: string | null | undefined) => (c ? CHANNEL_NAME[c] ?? c : "");

/** ข้อความผลการส่งหลังบันทึก */
export function deliveryText(d: DeliveryResult | null | undefined): string {
  if (!d) return "";
  if (d.sent) return `ส่งข้อความนัดทาง ${channelName(d.via)} แล้ว`;
  return d.error ?? "ส่งข้อความไม่สำเร็จ";
}

export const OTHER_PURPOSE = "อื่นๆ";
const UNIT_LABEL: Record<DateUnit, string> = { day: "วัน", week: "สัปดาห์", month: "เดือน" };
const monthOf = (date: string) => date.slice(0, 7);
const monthRange = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10) };
};

/**
 * ฟอร์มนัดเดียวกันทั้งหน้านัดหมายและกล่องขวาของแชท
 * เน้นกดน้อย: ปุ่มเหตุผลนัด (เลือกวันให้ตาม preset) ปุ่มลัดวัน ปุ่มช่วงเวลาตามเวลาเปิดคลินิก
 */
export function AppointmentForm({ initial, hisName, lockHn = false, conversationId, bookingId, appointmentId, showPatient = true, compact = false, saveLabel, onSaved, onCancel }: {
  initial: AppointmentDraft;
  /** ชื่อที่ได้จาก iService ถ้าไม่ได้แก้ ระบบใช้เป็นชื่อ HIS ตอนผูกแชท */
  hisName?: string;
  /** HN มาจาก iService แก้ไม่ได้ (หน้านัดหมาย) */
  lockHn?: boolean;
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
  const [counts, setCounts] = useState<DayCounts>({});
  const [loadedMonths, setLoadedMonths] = useState<Set<string>>(new Set());
  const [showCalendar, setShowCalendar] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(monthOf(initial.appoint_date || bangkokToday()));
  const [relAmount, setRelAmount] = useState("");
  const [relUnit, setRelUnit] = useState<DateUnit>("day");
  const [outsideOk, setOutsideOk] = useState(false);
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

  const schedule: ClinicSchedule = data?.schedule ?? { hours: DEFAULT_CLINIC_HOURS, closures: {} };
  const slots = form.appoint_date ? slotsForDate(form.appoint_date, schedule) : [];
  const closed = !!form.appoint_date && isClosedDate(form.appoint_date, schedule);
  const closureReason = form.appoint_date ? schedule.closures[form.appoint_date] : undefined;

  // จำนวนนัดต่อวัน: โหลดทีละเดือน (เดือนของวันที่เลือก และเดือนที่เปิดในปฏิทิน)
  const loadMonth = useCallback((month: string) => {
    if (loadedMonths.has(month)) return;
    setLoadedMonths((s) => new Set(s).add(month));
    const { from, to } = monthRange(month);
    fetch(`/api/appointments/day-counts?from=${from}&to=${to}`).then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setCounts((c) => ({ ...c, ...j.counts }))).catch(() => {});
  }, [loadedMonths]);
  useEffect(() => { if (form.appoint_date) loadMonth(monthOf(form.appoint_date)); }, [form.appoint_date, loadMonth]);
  useEffect(() => { if (showCalendar) loadMonth(calendarMonth); }, [showCalendar, calendarMonth, loadMonth]);

  // เปลี่ยนวันแล้วช่วงเดิมไม่มีในวันนั้น: เลือกช่วงเช้า (ค่าเริ่มต้น) หรือช่วงแรกของวัน
  useEffect(() => {
    if (form.time_mode !== "slot" || !slots.length || slots.some((s) => s.slot_id === form.slot_id)) return;
    set({ slot_id: (slots.find((s) => s.slot_id === DEFAULT_SLOT_ID) ?? slots[0]).slot_id });
  }, [form.appoint_date, form.time_mode, slots, form.slot_id]);

  useEffect(() => { setOutsideOk(false); }, [form.appoint_date, form.time_start, form.time_mode]);

  const presets = data?.presets ?? [];
  const otherPreset = presets.find((p) => p.name === OTHER_PURPOSE);
  const mainPresets = presets.filter((p) => p !== otherPreset);
  // พิมพ์เหตุผลเอง: เลือก preset "อื่นๆ" หรือข้อความที่ไม่ตรงกับ preset ใด
  const isOther = form.purpose_id
    ? form.purpose_id === otherPreset?.id
    : !!form.purpose_text && !mainPresets.some((p) => p.name === form.purpose_text);
  const [otherOpen, setOtherOpen] = useState(isOther);
  useEffect(() => { if (isOther) setOtherOpen(true); }, [isOther]);

  function pickPurpose(p: PurposePreset | null) {
    const previous = presets.find((x) => x.id === form.purpose_id);
    // การปฏิบัติตัวที่ยังเป็นค่าของ preset เดิม (หรือว่าง) เปลี่ยนตาม preset ใหม่ ถ้าแก้เองแล้วไม่ทับ
    const instructionsUntouched = !form.instructions.trim() || form.instructions === (previous?.reminder_extra_text ?? "");
    if (!p || p === otherPreset) {
      setOtherOpen(true);
      set({
        purpose_id: otherPreset?.id ?? "", purpose_text: isOther ? form.purpose_text : "",
        ...(instructionsUntouched ? { instructions: otherPreset?.reminder_extra_text ?? "" } : {}),
      });
      return;
    }
    setOtherOpen(false);
    set({
      purpose_id: p.id, purpose_text: p.name,
      ...(instructionsUntouched ? { instructions: p.reminder_extra_text ?? "" } : {}),
      ...(p.default_days ? { appoint_date: addDays(today, p.default_days) } : {}),
    });
  }

  function applyRelative() {
    const d = relativeDate(today, Number(relAmount), relUnit);
    if (d) set({ appoint_date: d });
  }

  const dayCount = form.appoint_date ? counts[form.appoint_date] : undefined;
  const outside = form.time_mode === "exact" && !!form.appoint_date && !!form.time_start && !isWithinOpenHours(form.appoint_date, form.time_start, schedule);
  const willSend = !!conversationId || !!data?.linked;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.appoint_date) return setErr("เลือกวันนัด");
    if (form.time_mode === "slot" && !slots.some((s) => s.slot_id === form.slot_id)) return setErr("วันนี้ไม่มีช่วงเวลาที่เลือก — ระบุเวลา หรือเลื่อนไปวันเปิด");
    if (form.time_mode === "exact" && !form.time_start) return setErr("ระบุเวลา");
    if (outside && !outsideOk) return setErr("เวลานี้อยู่นอกเวลาทำการ — ติ๊กยืนยันก่อนบันทึก");
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(appointmentId ? `/api/appointments/${appointmentId}` : "/api/appointments", {
        method: appointmentId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          purpose_id: form.purpose_id || null,
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
          <label>HN<input value={form.hn} onChange={(e) => set({ hn: e.target.value })} inputMode="numeric" autoComplete="off" readOnly={lockHn} /></label>
          <label className="span2">ชื่อคนไข้<input required value={form.patient_name} onChange={(e) => set({ patient_name: e.target.value })} autoComplete="off" /></label>
          <label>เบอร์โทร<input value={form.phone} onChange={(e) => set({ phone: e.target.value })} inputMode="tel" autoComplete="off" /></label>
        </div>
      )}

      <fieldset className="appt-field">
        <legend>เหตุผลนัด</legend>
        <div className="appt-chips">
          {mainPresets.map((p) => (
            <button type="button" key={p.id} className={`appt-chip ${form.purpose_id === p.id ? "on" : ""}`} onClick={() => pickPurpose(p)}
              title={p.default_days ? `นัดอีก ${p.default_days} วัน` : undefined}>
              {p.name}{p.default_days ? <span className="appt-chip-hint"> +{p.default_days}ว</span> : null}
            </button>
          ))}
          <button type="button" className={`appt-chip ${otherOpen ? "on" : ""}`} onClick={() => pickPurpose(otherPreset ?? null)}>{OTHER_PURPOSE}</button>
        </div>
        {otherOpen && (
          <input list="appt-purposes" autoFocus={!form.purpose_text} value={form.purpose_text} onChange={(e) => set({ purpose_text: e.target.value })}
            placeholder="พิมพ์เหตุผลนัด" aria-label="เหตุผลนัด (พิมพ์เอง)" autoComplete="off" />
        )}
        <datalist id="appt-purposes">{data?.purposeHistory.map((p) => <option key={p} value={p} />)}</datalist>
      </fieldset>

      <fieldset className="appt-field">
        <legend>วันนัด</legend>
        <div className="appt-chips">
          {quick.map((q) => (
            <button type="button" key={q.label} className={`appt-chip ${form.appoint_date === q.date ? "on" : ""}`} onClick={() => set({ appoint_date: q.date })}>
              {q.label}
            </button>
          ))}
          <span className="appt-rel">
            <input type="number" min={0} max={999} inputMode="numeric" aria-label="อีกกี่" placeholder="เช่น 10" value={relAmount}
              onChange={(e) => setRelAmount(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyRelative(); } }} />
            <select aria-label="หน่วย" value={relUnit} onChange={(e) => setRelUnit(e.target.value as DateUnit)}>
              {(Object.keys(UNIT_LABEL) as DateUnit[]).map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
            </select>
            <button type="button" className="btn ghost small" onClick={applyRelative} disabled={!relAmount}>ใช้</button>
          </span>
          <button type="button" className={`appt-chip ${showCalendar ? "on" : ""}`} aria-expanded={showCalendar}
            onClick={() => { setShowCalendar(!showCalendar); setCalendarMonth(monthOf(form.appoint_date || today)); }}>ปฏิทิน</button>
        </div>
        {showCalendar && (
          <MonthCalendar month={calendarMonth} onMonth={setCalendarMonth} selected={form.appoint_date} min={today}
            counts={counts} schedule={schedule} onPick={(d) => set({ appoint_date: d })} />
        )}
        {form.appoint_date && (
          <div className="appt-picked">
            {thaiFullDate(form.appoint_date)}
            <span className="appt-count">
              {" "}· นัดไว้แล้ว {dayCount?.total ?? 0} ราย
              {dayCount && dayCount.total > 0 && slots.length > 0 && (
                <> ({[...slots.map((s) => `${s.label} ${dayCount.slots[s.slot_id] ?? 0}`), ...(dayCount.slots.exact ? [`ระบุเวลา ${dayCount.slots.exact}`] : [])].join(" · ")})</>
              )}
            </span>
          </div>
        )}
        {closed && (
          <div className="appt-warn" role="alert">
            {closureReason !== undefined ? `วันหยุดพิเศษ${closureReason ? `: ${closureReason}` : ""}` : "คลินิกปิดวันนี้"}
            {nextOpenDate(form.appoint_date, schedule) && (
              <button type="button" className="btn ghost small" onClick={() => set({ appoint_date: nextOpenDate(form.appoint_date, schedule) as string })}>
                เลื่อนไปวันเปิดถัดไป
              </button>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className="appt-field">
        <legend>เวลา</legend>
        <div className="appt-chips">
          {slots.map((s) => (
            <button type="button" key={s.slot_id} className={`appt-chip ${form.time_mode === "slot" && form.slot_id === s.slot_id ? "on" : ""}`}
              onClick={() => set({ time_mode: "slot", slot_id: s.slot_id })}>
              {s.label} <span className="appt-chip-hint">{thaiClock(s.start)}–{thaiClock(s.end)}</span>
              {dayCount?.slots[s.slot_id] ? <span className="appt-chip-count">{dayCount.slots[s.slot_id]}</span> : null}
            </button>
          ))}
          <button type="button" className={`appt-chip ${form.time_mode === "exact" ? "on" : ""}`} onClick={() => set({ time_mode: "exact" })}>ระบุเวลา</button>
          {form.time_mode === "exact" && (
            <input type="time" aria-label="เวลานัด" className="appt-time" value={form.time_start} onChange={(e) => set({ time_start: e.target.value })} />
          )}
        </div>
        {outside && (
          <label className="appt-warn raw">
            <input type="checkbox" checked={outsideOk} onChange={(e) => setOutsideOk(e.target.checked)} />
            นอกเวลาทำการ — ยืนยันนัดเวลานี้
          </label>
        )}
      </fieldset>

      <div className="appt-grid">
        <label className="span4">การปฏิบัติตัว (ส่งในข้อความนัดและพิมพ์บนใบนัด)
          <textarea rows={2} value={form.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder="เช่น งดน้ำงดอาหาร 8–12 ชม." />
        </label>
        <label className="span2">ผู้นัด
          <input list="appt-providers" value={form.provider} onChange={(e) => set({ provider: e.target.value })} autoComplete="off" />
        </label>
        <label className="span2">หมายเหตุ (ภายใน/บนใบนัด)
          <input value={form.note} onChange={(e) => set({ note: e.target.value })} autoComplete="off" />
        </label>
      </div>
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
