"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bangkokToday, DEFAULT_CLINIC_HOURS, DEFAULT_SLOT_ID, defaultSeriesLabel, isClosedDate, isWithinOpenHours, nextOpenDate, offsetFromDays,
  relativeDate, slotsForDate, thaiClock, thaiMediumDate,
  type Appointment, type ClinicSchedule, type DateUnit, type SeriesFrom, type TimeMode,
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
export interface SaveResult { appointment: Appointment; delivery: DeliveryResult | null; moved?: boolean; shifted?: number }

export interface PurposePreset { id: string; name: string; default_days: number | null; reminder_extra_text: string | null }
export interface SeriesTemplate {
  id: string; name: string; purpose_id: string | null;
  items: { label: string; offset_value: number; offset_unit: DateUnit; from: SeriesFrom }[];
}

interface FormData {
  presets: PurposePreset[];
  purposeHistory: string[];
  providers: string[];
  linked: { conversation_id: string; channel: ChannelType | null } | null;
  schedule: ClinicSchedule;
  templates?: SeriesTemplate[];
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
const monthOf = (date: string) => date.slice(0, 7);
const monthRange = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10) };
};

// ---------------------------------------------------------------------------
// เลือกวันด้วยตัวเลข: วัน / สัปดาห์ / เดือน ใช้ได้ทีละช่อง นับจากวันฐาน
// ---------------------------------------------------------------------------
export interface Offset { unit: DateUnit; value: number | "" }
const UNITS: [DateUnit, string][] = [["day", "วัน"], ["week", "สัปดาห์"], ["month", "เดือน"]];

export const offsetDate = (base: string, o: Offset | null) =>
  o && o.value !== "" && base ? relativeDate(base, Number(o.value), o.unit) : null;

export function DateOffsetField({ offset, onOffset, label }: { offset: Offset | null; onOffset: (o: Offset | null) => void; label: string }) {
  const valueOf = (u: DateUnit) => (offset?.unit === u ? offset.value : "");
  const step = (u: DateUnit, d: number) => {
    const cur = offset?.unit === u && offset.value !== "" ? Number(offset.value) : 0;
    onOffset({ unit: u, value: Math.max(0, Math.min(999, cur + d)) });
  };
  return (
    <div className="offset-fields" role="group" aria-label={label}>
      {UNITS.map(([u, name]) => (
        <div key={u} className={`offset-field ${offset?.unit === u ? "on" : ""}`}>
          <button type="button" className="offset-step" aria-label={`ลด${name}`} onClick={() => step(u, -1)}>−</button>
          <input type="number" inputMode="numeric" min={0} max={999} aria-label={`อีกกี่${name}`} value={valueOf(u)} placeholder="0"
            onFocus={() => { if (offset?.unit !== u) onOffset({ unit: u, value: "" }); }}
            onChange={(e) => onOffset({ unit: u, value: e.target.value === "" ? "" : Math.max(0, Math.min(999, Math.floor(Number(e.target.value)))) })} />
          <button type="button" className="offset-step" aria-label={`เพิ่ม${name}`} onClick={() => step(u, 1)}>+</button>
          <span className="offset-unit">{name}</span>
        </div>
      ))}
    </div>
  );
}

/** วันที่ที่เลือก ตัวใหญ่ + นัดไว้แล้วกี่ราย + เตือนวันปิด */
function DateSummary({ date, schedule, counts, onMove }: { date: string; schedule: ClinicSchedule; counts: DayCounts; onMove: (d: string) => void }) {
  if (!date) return <div className="appt-date-big muted">ยังไม่ได้เลือกวัน</div>;
  const slots = slotsForDate(date, schedule);
  const dayCount = counts[date];
  const closed = isClosedDate(date, schedule);
  const reason = schedule.closures[date];
  const next = closed ? nextOpenDate(date, schedule) : null;
  return (
    <>
      <div className="appt-date-big">{thaiMediumDate(date)}</div>
      <div className="appt-count small">
        นัดไว้แล้ว {dayCount?.total ?? 0} ราย
        {dayCount && dayCount.total > 0 && slots.length > 0 && (
          <> ({[...slots.map((s) => `${s.label} ${dayCount.slots[s.slot_id] ?? 0}`), ...(dayCount.slots.exact ? [`ระบุเวลา ${dayCount.slots.exact}`] : [])].join(" · ")})</>
        )}
      </div>
      {closed && (
        <div className="appt-warn" role="alert">
          {reason !== undefined ? `วันหยุดพิเศษ${reason ? `: ${reason}` : ""}` : "คลินิกปิดวันนี้"}
          {next && <button type="button" className="btn ghost small" onClick={() => onMove(next)}>เลื่อนไปวันเปิดถัดไป</button>}
        </div>
      )}
    </>
  );
}

/** ปุ่มช่วงเวลาของวันนั้น + ระบุเวลา */
function TimeChoice({ date, schedule, counts, mode, slotId, timeStart, onChange }: {
  date: string; schedule: ClinicSchedule; counts: DayCounts; mode: TimeMode; slotId: string; timeStart: string;
  onChange: (p: { time_mode?: TimeMode; slot_id?: string; time_start?: string }) => void;
}) {
  const slots = date ? slotsForDate(date, schedule) : [];
  const dayCount = date ? counts[date] : undefined;
  return (
    <div className="appt-chips">
      {slots.map((s) => (
        <button type="button" key={s.slot_id} className={`appt-chip ${mode === "slot" && slotId === s.slot_id ? "on" : ""}`}
          onClick={() => onChange({ time_mode: "slot", slot_id: s.slot_id })}>
          {s.label} <span className="appt-chip-hint">{thaiClock(s.start)}–{thaiClock(s.end)}</span>
          {dayCount?.slots[s.slot_id] ? <span className="appt-chip-count">{dayCount.slots[s.slot_id]}</span> : null}
        </button>
      ))}
      <button type="button" className={`appt-chip ${mode === "exact" ? "on" : ""}`} onClick={() => onChange({ time_mode: "exact" })}>ระบุเวลา</button>
      {mode === "exact" && <input type="time" aria-label="เวลานัด" className="appt-time" value={timeStart} onChange={(e) => onChange({ time_start: e.target.value })} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// นัดถัดไปในชุด
// ---------------------------------------------------------------------------
interface SeriesBlock {
  key: number;
  label: string;
  from: SeriesFrom;
  offset: Offset | null;
  time_mode: TimeMode;
  slot_id: string;
  time_start: string;
}

let blockKey = 0;
const newBlock = (seq: number, o: Partial<SeriesBlock> = {}): SeriesBlock => ({
  key: ++blockKey, label: defaultSeriesLabel(seq), from: "previous", offset: null, time_mode: "slot", slot_id: DEFAULT_SLOT_ID, time_start: "", ...o,
});

/** วันของแต่ละบล็อก: นับจากนัดแรกหรือนัดก่อนหน้า */
function blockDates(first: string, blocks: SeriesBlock[]): string[] {
  const out: string[] = [];
  blocks.forEach((b, i) => {
    const base = b.from === "first" ? first : i === 0 ? first : out[i - 1];
    out.push(offsetDate(base, b.offset) ?? "");
  });
  return out;
}

/**
 * ฟอร์มนัดเดียวกันทั้งหน้านัดหมายและกล่องขวาของแชท
 * เลือกวันด้วยตัวเลข วัน/สัปดาห์/เดือน (ทีละช่อง) หรือปฏิทิน ปุ่มเหตุผลนัด ปุ่มช่วงเวลาตามเวลาเปิดคลินิก
 * ทำนัดใหม่เพิ่มนัดถัดไปเป็นชุดได้ (เช่น วัคซีนหลายเข็ม)
 */
export function AppointmentForm({ initial, hisName, lockHn = false, conversationId, bookingId, appointmentId, seriesFollowing = 0, showPatient = true, compact = false, saveLabel, onSaved, onCancel }: {
  initial: AppointmentDraft;
  /** ชื่อที่ได้จาก iService ถ้าไม่ได้แก้ ระบบใช้เป็นชื่อ HIS ตอนผูกแชท */
  hisName?: string;
  /** HN มาจาก iService แก้ไม่ได้ (หน้านัดหมาย) */
  lockHn?: boolean;
  conversationId?: string;
  bookingId?: string;
  /** แก้นัดเดิม */
  appointmentId?: string;
  /** แก้นัดในชุด: จำนวนนัดถัดไปที่ยังเปิดอยู่ (ถามว่าจะเลื่อนตามไหม) */
  seriesFollowing?: number;
  showPatient?: boolean;
  compact?: boolean;
  saveLabel?: string;
  onSaved: (r: SaveResult) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<AppointmentDraft>(initial);
  const [offset, setOffset] = useState<Offset | null>(null);
  const [data, setData] = useState<FormData | null>(null);
  const [counts, setCounts] = useState<DayCounts>({});
  const [loadedMonths, setLoadedMonths] = useState<Set<string>>(new Set());
  const [showCalendar, setShowCalendar] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(monthOf(initial.appoint_date || bangkokToday()));
  const [outsideOk, setOutsideOk] = useState(false);
  const [blocks, setBlocks] = useState<SeriesBlock[]>([]);
  const [firstLabel, setFirstLabel] = useState(defaultSeriesLabel(1));
  const [templateId, setTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const today = bangkokToday();
  const set = (patch: Partial<AppointmentDraft>) => setForm((f) => ({ ...f, ...patch }));
  const creating = !appointmentId;

  // HN เปลี่ยน → ดูว่ามีแชทแล้วหรือยัง (หน่วงไว้ไม่ให้ยิงทุกตัวอักษร)
  useEffect(() => {
    const hn = form.hn.trim();
    const t = setTimeout(() => {
      fetch(`/api/appointments/form-data${hn ? `?hn=${encodeURIComponent(hn)}` : ""}`)
        .then((r) => (r.ok ? r.json() : null)).then((d) => d && setData(d as FormData)).catch(() => {});
    }, hn ? 300 : 0);
    return () => clearTimeout(t);
  }, [form.hn]);

  // ตัวเลขวัน/สัปดาห์/เดือน → วันนัด (นับจากวันนี้ ทันทีที่พิมพ์)
  useEffect(() => {
    const d = offsetDate(today, offset);
    if (d && d !== form.appoint_date) set({ appoint_date: d });
  }, [offset, today]);

  const schedule: ClinicSchedule = data?.schedule ?? { hours: DEFAULT_CLINIC_HOURS, closures: {} };
  const slots = form.appoint_date ? slotsForDate(form.appoint_date, schedule) : [];
  const dates = useMemo(() => blockDates(form.appoint_date, blocks), [form.appoint_date, blocks]);

  // จำนวนนัดต่อวัน: โหลดทีละเดือน
  const loadMonth = useCallback((month: string) => {
    if (loadedMonths.has(month)) return;
    setLoadedMonths((s) => new Set(s).add(month));
    const { from, to } = monthRange(month);
    fetch(`/api/appointments/day-counts?from=${from}&to=${to}`).then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setCounts((c) => ({ ...c, ...j.counts }))).catch(() => {});
  }, [loadedMonths]);
  useEffect(() => {
    for (const d of [form.appoint_date, ...dates]) if (d) loadMonth(monthOf(d));
  }, [form.appoint_date, dates, loadMonth]);
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
    set({ purpose_id: p.id, purpose_text: p.name, ...(instructionsUntouched ? { instructions: p.reminder_extra_text ?? "" } : {}) });
    // preset ที่มีจำนวนวัน: ใส่ช่องวัน (หรือเดือนถ้าหาร 30 ลงตัว)
    if (p.default_days) setOffset(offsetFromDays(p.default_days));
  }

  function pickDate(d: string) {
    setOffset(null);
    set({ appoint_date: d });
  }

  function applyTemplate(id: string) {
    setTemplateId(id);
    const t = data?.templates?.find((x) => x.id === id);
    if (!t || !t.items.length) return;
    const [first, ...rest] = t.items;
    setFirstLabel(first.label || defaultSeriesLabel(1));
    setOffset({ unit: first.offset_unit, value: first.offset_value });
    setBlocks(rest.map((it, i) => newBlock(i + 2, { label: it.label || defaultSeriesLabel(i + 2), from: it.from, offset: { unit: it.offset_unit, value: it.offset_value } })));
    const preset = presets.find((p) => p.id === t.purpose_id);
    if (preset) pickPurpose(preset);
  }

  const setBlock = (key: number, patch: Partial<SeriesBlock>) => setBlocks((bs) => bs.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  const outside = form.time_mode === "exact" && !!form.appoint_date && !!form.time_start && !isWithinOpenHours(form.appoint_date, form.time_start, schedule);
  const willSend = !!conversationId || !!data?.linked;
  const moved = !creating && (form.appoint_date !== initial.appoint_date || form.time_mode !== initial.time_mode || form.slot_id !== initial.slot_id || form.time_start !== initial.time_start);

  async function save(e: React.FormEvent | null, shiftFollowing = false) {
    e?.preventDefault();
    if (!form.appoint_date) return setErr("เลือกวันนัด");
    if (form.time_mode === "slot" && !slots.some((s) => s.slot_id === form.slot_id)) return setErr("วันนี้ไม่มีช่วงเวลาที่เลือก — ระบุเวลา หรือเลื่อนไปวันเปิด");
    if (form.time_mode === "exact" && !form.time_start) return setErr("ระบุเวลา");
    if (outside && !outsideOk) return setErr("เวลานี้อยู่นอกเวลาทำการ — ติ๊กยืนยันก่อนบันทึก");
    const missing = blocks.findIndex((_, i) => !dates[i]);
    if (missing >= 0) return setErr(`ใส่จำนวนวัน/สัปดาห์/เดือนของ${blocks[missing].label}`);
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(appointmentId ? `/api/appointments/${appointmentId}` : "/api/appointments", {
        method: appointmentId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          purpose_id: form.purpose_id || null,
          ...(appointmentId ? { shift_following: shiftFollowing } : {
            conversation_id: conversationId, booking_id: bookingId, name_from_his: !!hisName && form.patient_name.trim() === hisName.trim(),
            ...(blocks.length ? {
              series_label: firstLabel,
              series_title: data?.templates?.find((t) => t.id === templateId)?.name ?? form.purpose_text,
              series_items: blocks.map((b, i) => ({
                label: b.label, appoint_date: dates[i], time_mode: b.time_mode, slot_id: b.slot_id, time_start: b.time_start,
                from: b.from, offset_value: b.offset?.value === "" ? null : b.offset?.value ?? null, offset_unit: b.offset?.unit ?? null,
              })),
            } : {}),
          }),
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
    <form className={`appt-form ${compact ? "compact" : ""}`} onSubmit={(e) => save(e)}>
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

      {creating && !!data?.templates?.length && (
        <label className="appt-template">ใช้ template ชุดนัด
          <select value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
            <option value="">— ไม่ใช้ —</option>
            {data.templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.items.length} นัด)</option>)}
          </select>
        </label>
      )}

      <fieldset className={`appt-field ${blocks.length ? "appt-series-block first" : ""}`}>
        <legend>{blocks.length ? <input className="series-label" aria-label="ชื่อนัดแรก" value={firstLabel} onChange={(e) => setFirstLabel(e.target.value)} /> : "วันนัด"}</legend>
        <div className="appt-date-row">
          <span className="muted small">นัดอีก</span>
          <DateOffsetField label="นัดอีกกี่วัน สัปดาห์ หรือเดือน นับจากวันนี้" offset={offset} onOffset={setOffset} />
          <button type="button" className={`appt-chip ${showCalendar ? "on" : ""}`} aria-expanded={showCalendar}
            onClick={() => { setShowCalendar(!showCalendar); setCalendarMonth(monthOf(form.appoint_date || today)); }}>ปฏิทิน</button>
        </div>
        {showCalendar && (
          <MonthCalendar month={calendarMonth} onMonth={setCalendarMonth} selected={form.appoint_date} min={today}
            counts={counts} schedule={schedule} onPick={pickDate} />
        )}
        <DateSummary date={form.appoint_date} schedule={schedule} counts={counts} onMove={pickDate} />
        <TimeChoice date={form.appoint_date} schedule={schedule} counts={counts} mode={form.time_mode} slotId={form.slot_id} timeStart={form.time_start}
          onChange={(p) => set(p)} />
        {outside && (
          <label className="appt-warn raw">
            <input type="checkbox" checked={outsideOk} onChange={(e) => setOutsideOk(e.target.checked)} />
            นอกเวลาทำการ — ยืนยันนัดเวลานี้
          </label>
        )}
      </fieldset>

      {creating && blocks.map((b, i) => (
        <fieldset key={b.key} className="appt-field appt-series-block">
          <legend className="series-head">
            <input className="series-label" aria-label={`ชื่อนัดที่ ${i + 2}`} value={b.label} onChange={(e) => setBlock(b.key, { label: e.target.value })} />
            <button type="button" className="btn ghost small" aria-label={`ลบ ${b.label}`} onClick={() => setBlocks((bs) => bs.filter((x) => x.key !== b.key))}>ลบ</button>
          </legend>
          <div className="appt-date-row">
            <span className="muted small">อีก</span>
            <DateOffsetField label={`${b.label} อีกกี่วัน สัปดาห์ หรือเดือน`} offset={b.offset} onOffset={(o) => setBlock(b.key, { offset: o })} />
            <label className="raw small">นับจาก
              <select value={b.from} onChange={(e) => setBlock(b.key, { from: e.target.value as SeriesFrom })}>
                <option value="first">{firstLabel || "นัดแรก"}</option>
                <option value="previous">นัดก่อนหน้า</option>
              </select>
            </label>
          </div>
          <DateSummary date={dates[i]} schedule={schedule} counts={counts} onMove={() => {}} />
          <TimeChoice date={dates[i]} schedule={schedule} counts={counts} mode={b.time_mode} slotId={b.slot_id} timeStart={b.time_start}
            onChange={(p) => setBlock(b.key, p)} />
        </fieldset>
      ))}
      {creating && (
        <button type="button" className="btn ghost small appt-add-next" onClick={() => setBlocks((bs) => [...bs, newBlock(bs.length + 2)])}>+ เพิ่มนัดถัดไป</button>
      )}

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

      {creating && (
        <div className={`appt-link-state ${willSend ? "ok" : ""}`}>
          {conversationId ? "จะส่งข้อความนัดเข้าแชทนี้ทันทีที่บันทึก"
            : data?.linked ? `HN นี้มีแชท ${channelName(data.linked.channel)} แล้ว — จะส่งข้อความนัดทันทีที่บันทึก`
            : "ยังไม่มีแชท — ให้คนไข้สแกน QR บนใบนัด"}
          {blocks.length > 0 && ` · ชุดนัด ${blocks.length + 1} นัด (ข้อความและใบนัดใบเดียวแสดงทุกนัด)`}
        </div>
      )}
      {err && <div className="error small" role="alert">{err}</div>}
      {moved && seriesFollowing > 0 ? (
        <div className="appt-shift-ask">
          <span className="small">เลื่อนนัดถัดไปในชุดตามด้วยไหม? ({seriesFollowing} นัด เฉพาะที่นับจากนัดนี้)</span>
          <div className="row">
            <button type="button" className="btn primary" disabled={busy} onClick={() => save(null, true)}>บันทึก + เลื่อนนัดถัดไปตาม</button>
            <button type="button" className="btn outline" disabled={busy} onClick={() => save(null, false)}>เฉพาะนัดนี้</button>
            <button type="button" className="btn ghost" onClick={onCancel}>ยกเลิก</button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button className="btn primary" disabled={busy}>{busy ? "กำลังบันทึก…" : saveLabel ?? (appointmentId ? "บันทึกการแก้ไข" : blocks.length ? `บันทึกชุดนัด (${blocks.length + 1} นัด)` : "บันทึกนัด")}</button>
          <button type="button" className="btn ghost" onClick={onCancel}>ยกเลิก</button>
        </div>
      )}
    </form>
  );
}
