"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { bangkokToday, thaiFullDate } from "@/lib/appointment-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { InfoTip } from "./info-tip";

export interface Preset { id: string; name: string; default_days: number | null; reminder_extra_text: string | null; sort_order: number; active: boolean }
export interface Slot { weekday: number; slot_id: string; label: string; start_time: string; end_time: string; sort_order: number }
interface Closure { closed_on: string; reason: string | null }

const DAY = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

/** preset เหตุผลนัด: เพิ่ม แก้ ลากเรียง ปิดใช้ (admin เขียนตรงผ่าน RLS) */
export function PurposePresets({ initial = [] }: { initial?: Preset[] } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  // initial: ข้อมูลตั้งต้นก่อนโหลด (ภาพตัวอย่าง/เทสต์) หน้าใช้งานจริงโหลดจากฐานข้อมูลเสมอ
  const [rows, setRows] = useState<Preset[]>(initial);
  const [drag, setDrag] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const [draft, setDraft] = useState({ name: "", default_days: "", reminder_extra_text: "" });

  const load = useCallback(async () => {
    const { data } = await sb.from("appointment_purposes").select("id, name, default_days, reminder_extra_text, sort_order, active").order("sort_order");
    setRows((data ?? []) as Preset[]);
  }, [sb]);
  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3000); };
  const days = (v: string) => (v.trim() && Number(v) > 0 ? Math.min(3650, Math.floor(Number(v))) : null);

  async function saveRow(r: Preset) {
    const { error } = await sb.from("appointment_purposes").update({
      name: r.name.trim(), default_days: r.default_days, reminder_extra_text: r.reminder_extra_text?.trim() || null, active: r.active, updated_at: new Date().toISOString(),
    }).eq("id", r.id);
    flash(error ? `บันทึกไม่สำเร็จ: ${error.message}` : "บันทึกแล้ว ✓");
    load();
  }

  async function persistOrder(list: Preset[]) {
    setRows(list);
    const results = await Promise.all(list.map((r, i) => sb.from("appointment_purposes").update({ sort_order: (i + 1) * 10 }).eq("id", r.id)));
    if (results.some((r) => r.error)) flash("เรียงลำดับไม่สำเร็จ");
    load();
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= rows.length || from === to) return;
    const list = [...rows];
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    persistOrder(list);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.name.trim()) return;
    const { error } = await sb.from("appointment_purposes").insert({
      name: draft.name.trim(), default_days: days(draft.default_days), reminder_extra_text: draft.reminder_extra_text.trim() || null,
      sort_order: (rows.at(-1)?.sort_order ?? 0) + 10,
    });
    if (error) return flash(error.code === "23505" ? "มีชื่อนี้แล้ว" : `เพิ่มไม่สำเร็จ: ${error.message}`);
    setDraft({ name: "", default_days: "", reminder_extra_text: "" });
    load();
  }

  const setRow = (i: number, patch: Partial<Preset>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="appt-settings-block">
      <h3>เหตุผลนัด (preset) <InfoTip text={'ลาก ⋮⋮ หรือกด ↑↓ เพื่อเรียงลำดับ · "นัดอีก (วัน)" = เลือกวันนัดให้อัตโนมัติ · "การปฏิบัติตัว" = ค่าเริ่มต้นที่ส่งในข้อความนัดเสมอ'} /></h3>
      <div className="set-table-wrap">
        <table className="set-table preset-table">
          <thead>
            <tr><th aria-label="ลากเรียง" /><th>เหตุผลนัด</th><th>นัดอีก (วัน)</th><th>การปฏิบัติตัว</th><th>ใช้</th><th aria-label="จัดการ" /></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className={`${r.active ? "" : "off"} ${drag === i ? "dragging" : ""}`} draggable
                onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDragEnd={() => setDrag(null)}
                onDrop={(e) => { e.preventDefault(); if (drag !== null) move(drag, i); setDrag(null); }}>
                <td className="preset-handle" aria-hidden="true">⋮⋮</td>
                <td><input aria-label="ชื่อเหตุผลนัด" value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} /></td>
                <td className="num"><input aria-label="นัดอีกกี่วัน" type="number" min={1} placeholder="–"
                  value={r.default_days ?? ""} onChange={(e) => setRow(i, { default_days: days(e.target.value) })} /></td>
                <td><input aria-label="การปฏิบัติตัว" placeholder="–"
                  value={r.reminder_extra_text ?? ""} onChange={(e) => setRow(i, { reminder_extra_text: e.target.value })} /></td>
                <td className="center"><input type="checkbox" aria-label={`ใช้ ${r.name}`} checked={r.active} onChange={(e) => setRow(i, { active: e.target.checked })} /></td>
                <td className="actions">
                  <button type="button" className="icon-btn ghost-icon" aria-label={`เลื่อน ${r.name} ขึ้น`} disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
                  <button type="button" className="icon-btn ghost-icon" aria-label={`เลื่อน ${r.name} ลง`} disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}>↓</button>
                  <button type="button" className="btn small" onClick={() => saveRow(r)}>บันทึก</button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="preset-handle" aria-hidden="true">＋</td>
              <td><input form="preset-add" aria-label="ชื่อเหตุผลนัดใหม่" placeholder="เหตุผลนัดใหม่" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></td>
              <td className="num"><input form="preset-add" aria-label="นัดอีกกี่วัน" type="number" min={1} placeholder="วัน" value={draft.default_days} onChange={(e) => setDraft({ ...draft, default_days: e.target.value })} /></td>
              <td><input form="preset-add" aria-label="การปฏิบัติตัว" placeholder="การปฏิบัติตัว" value={draft.reminder_extra_text} onChange={(e) => setDraft({ ...draft, reminder_extra_text: e.target.value })} /></td>
              <td />
              <td className="actions"><button form="preset-add" className="btn primary small" disabled={!draft.name.trim()}>เพิ่ม</button></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <form id="preset-add" onSubmit={add} hidden />
      {msg && <div className="small">{msg}</div>}
    </div>
  );
}

/** เวลาเปิดคลินิกต่อวันในสัปดาห์ (หลายช่วงต่อวัน ไม่มีช่วง = ปิดทั้งวัน) และวันหยุดพิเศษ */
export function ClinicHoursSettings({ initialSlots = [] }: { initialSlots?: Slot[] } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [slots, setSlots] = useState<Slot[]>(initialSlots);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [newClosure, setNewClosure] = useState({ date: "", reason: "" });
  const [msg, setMsg] = useState("");
  const today = bangkokToday();

  const load = useCallback(async () => {
    const [{ data: h }, { data: c }] = await Promise.all([
      sb.from("clinic_hours").select("weekday, slot_id, label, start_time, end_time, sort_order"),
      sb.from("clinic_closures").select("closed_on, reason").gte("closed_on", today).order("closed_on"),
    ]);
    setSlots(((h ?? []) as Slot[]).map((s) => ({ ...s, start_time: s.start_time.slice(0, 5), end_time: s.end_time.slice(0, 5) })));
    setClosures((c ?? []) as Closure[]);
  }, [sb, today]);
  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3000); };
  const ofDay = (d: number) => slots.filter((s) => s.weekday === d).sort((a, b) => a.start_time.localeCompare(b.start_time));
  const update = (s: Slot, patch: Partial<Slot>) => setSlots((list) => list.map((x) => (x === s ? { ...x, ...patch } : x)));

  function addSlot(d: number) {
    const used = new Set(ofDay(d).map((s) => s.slot_id));
    const preset = !used.has("morning") ? { slot_id: "morning", label: "ช่วงเช้า", start_time: "08:00", end_time: "12:00" }
      : !used.has("afternoon") ? { slot_id: "afternoon", label: "ช่วงบ่าย", start_time: "13:00", end_time: "18:00" }
      : { slot_id: `slot${used.size + 1}`, label: "ช่วงเย็น", start_time: "18:00", end_time: "20:00" };
    setSlots((list) => [...list, { weekday: d, sort_order: (used.size + 1) * 10, ...preset }]);
  }

  async function saveHours() {
    const bad = slots.find((s) => !s.label.trim() || !/^[a-z0-9_-]{1,30}$/.test(s.slot_id) || s.end_time <= s.start_time);
    if (bad) return flash(`${DAY[bad.weekday]}: ช่วงเวลาไม่ถูกต้อง (เวลาสิ้นสุดต้องหลังเวลาเริ่ม)`);
    const dup = slots.find((s, i) => slots.findIndex((x) => x.weekday === s.weekday && x.slot_id === s.slot_id) !== i);
    if (dup) return flash(`${DAY[dup.weekday]}: รหัสช่วง ${dup.slot_id} ซ้ำ`);
    // เขียนใหม่ทั้งตาราง ตารางเล็ก (ไม่เกิน 7 วัน × ไม่กี่ช่วง)
    const del = await sb.from("clinic_hours").delete().gte("weekday", 0);
    if (del.error) return flash(`บันทึกไม่สำเร็จ: ${del.error.message}`);
    if (slots.length) {
      const ins = await sb.from("clinic_hours").insert(slots.map((s) => ({ ...s, label: s.label.trim() })));
      if (ins.error) return flash(`บันทึกไม่สำเร็จ: ${ins.error.message}`);
    }
    flash("บันทึกเวลาเปิดแล้ว ✓");
    load();
  }

  async function addClosure(e: React.FormEvent) {
    e.preventDefault();
    if (!newClosure.date) return;
    const { error } = await sb.from("clinic_closures").upsert({ closed_on: newClosure.date, reason: newClosure.reason.trim() || null });
    if (error) return flash(`เพิ่มไม่สำเร็จ: ${error.message}`);
    setNewClosure({ date: "", reason: "" });
    load();
  }

  async function removeClosure(date: string) {
    await sb.from("clinic_closures").delete().eq("closed_on", date);
    load();
  }

  return (
    <div className="appt-settings-block">
      <div className="set-block-head">
        <h3>เวลาเปิดคลินิก (ช่วงนัด) <InfoTip text="ปุ่มช่วงเวลาในฟอร์มนัดมาจากตารางนี้ · วันที่ไม่มีช่วง = ปิดทั้งวัน · ช่วงเช้า (morning) เป็นค่าเริ่มต้น" /></h3>
        <button type="button" className="btn primary small" onClick={saveHours}>บันทึกเวลาเปิด</button>
      </div>
      <div className="set-table-wrap">
        <table className="set-table hours-grid">
          <thead><tr><th>วัน</th><th>ช่วงเวลา (ชื่อ · เริ่ม–สิ้นสุด)</th><th aria-label="เพิ่มช่วง" /></tr></thead>
          <tbody>
            {DAY.map((name, d) => (
              <tr key={d}>
                <th scope="row">{name}</th>
                <td>
                  <div className="hours-slots">
                    {ofDay(d).length === 0 && <span className="muted small">ปิดทั้งวัน</span>}
                    {ofDay(d).map((s) => (
                      <span key={`${d}-${s.slot_id}`} className="hours-slot">
                        <input aria-label={`ชื่อช่วง ${name}`} value={s.label} onChange={(e) => update(s, { label: e.target.value })} />
                        <input aria-label="เริ่ม" type="time" value={s.start_time} onChange={(e) => update(s, { start_time: e.target.value })} />
                        <span>–</span>
                        <input aria-label="สิ้นสุด" type="time" value={s.end_time} onChange={(e) => update(s, { end_time: e.target.value })} />
                        <button type="button" className="icon-btn ghost-icon" aria-label={`ลบ ${s.label} วัน${name}`} onClick={() => setSlots((l) => l.filter((x) => x !== s))}>✕</button>
                      </span>
                    ))}
                  </div>
                </td>
                <td className="actions"><button type="button" className="btn ghost small" onClick={() => addSlot(d)}>+ ช่วง</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="row set-closure" onSubmit={addClosure}>
        <b className="small">วันหยุดพิเศษ</b>
        <input type="date" aria-label="วันหยุด" min={today} value={newClosure.date} onChange={(e) => setNewClosure({ ...newClosure, date: e.target.value })} style={{ width: "auto" }} />
        <input aria-label="เหตุผล" placeholder="เช่น วันหยุดสงกรานต์" value={newClosure.reason} onChange={(e) => setNewClosure({ ...newClosure, reason: e.target.value })} style={{ flex: 1, width: "auto" }} />
        <button className="btn ghost" disabled={!newClosure.date}>เพิ่มวันหยุด</button>
        {closures.length === 0 && <span className="muted small">ยังไม่มี</span>}
      </form>

      {closures.map((c) => (
        <div key={c.closed_on} className="row small">
          <span>{thaiFullDate(c.closed_on)}{c.reason ? ` — ${c.reason}` : ""}</span>
          <button type="button" className="btn ghost small" onClick={() => removeClosure(c.closed_on)}>ลบ</button>
        </div>
      ))}
      {msg && <div className="small">{msg}</div>}
    </div>
  );
}
