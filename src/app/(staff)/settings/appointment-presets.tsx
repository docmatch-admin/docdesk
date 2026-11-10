"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bangkokToday, thaiFullDate } from "@/lib/appointment-rules";
import {
  DAY_NAME, DAY_ORDER, HOUR_GROUPS, addGroupSlot, hoursSignature, patchGroupSlot, removeGroupSlot, slotsOfDay, validateHours, weekdaysUniform,
  type HourSlot,
} from "@/lib/clinic-hours-group";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { SetGroup, SetLine, Switch, useSaveUnit } from "./settings-save";
import { DragHandle, ListSection, RowMenu, useDragSort } from "./settings-list";

export interface Preset { id: string; name: string; default_days: number | null; reminder_extra_text: string | null; sort_order: number; active: boolean }
export type Slot = HourSlot;
interface Closure { closed_on: string; reason: string | null }

const presetKey = (r: Preset) => JSON.stringify([r.name.trim(), r.default_days, r.reminder_extra_text?.trim() || null, r.active]);

/**
 * preset เหตุผลนัด: แถวกะทัดรัดแบบเดียวกับแท็ก · แก้แล้วบันทึกด้วยปุ่ม "บันทึกการตั้งค่า" ของหน้า (ไม่มีปุ่มบันทึกรายแถว)
 * เพิ่ม ลบ (เมนู ⋯) และเรียงลำดับ (ลาก ⋮⋮ หรือโฟกัสแล้วกด ↑/↓) มีผลทันที
 */
export function PurposePresets({ initial = [] }: { initial?: Preset[] } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  // initial: ข้อมูลตั้งต้นก่อนโหลด (ภาพตัวอย่าง/เทสต์) หน้าใช้งานจริงโหลดจากฐานข้อมูลเสมอ
  const [rows, setRows] = useState<Preset[]>(initial);
  const [saved, setSaved] = useState<Record<string, string>>(() => Object.fromEntries(initial.map((r) => [r.id, presetKey(r)])));
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState("");
  const [draft, setDraft] = useState({ name: "", default_days: "", reminder_extra_text: "" });

  const load = useCallback(async () => {
    const { data } = await sb.from("appointment_purposes").select("id, name, default_days, reminder_extra_text, sort_order, active").order("sort_order");
    const list = (data ?? []) as Preset[];
    // โหลดใหม่หลังเรียงลำดับ/เพิ่มแถว: แถวที่กำลังแก้ (ยังไม่บันทึก) คงค่าที่แก้ไว้
    const prevSaved = savedRef.current;
    setRows((cur) => list.map((r) => {
      const mine = cur.find((x) => x.id === r.id);
      return mine && prevSaved[r.id] !== undefined && presetKey(mine) !== prevSaved[r.id] ? { ...r, ...mine, sort_order: r.sort_order } : r;
    }));
    setSaved(Object.fromEntries(list.map((r) => [r.id, presetKey(r)])));
  }, [sb]);
  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3000); };
  const days = (v: string) => (v.trim() && Number(v) > 0 ? Math.min(3650, Math.floor(Number(v))) : null);
  const changed = rows.filter((r) => saved[r.id] !== undefined && saved[r.id] !== presetKey(r));
  const dirty = changed.length > 0;

  /** บันทึกทุกแถวที่แก้ (เรียกจากปุ่มบันทึกรวม) */
  async function save(): Promise<string | null> {
    const errors: Record<string, string> = {};
    for (const r of changed) {
      if (!r.name.trim()) { errors[r.id] = "ต้องมีชื่อเหตุผลนัด"; continue; }
      const { error } = await sb.from("appointment_purposes").update({
        name: r.name.trim(), default_days: r.default_days, reminder_extra_text: r.reminder_extra_text?.trim() || null, active: r.active, updated_at: new Date().toISOString(),
      }).eq("id", r.id);
      if (error) errors[r.id] = error.code === "23505" ? "มีชื่อนี้แล้ว" : error.message;
      else setSaved((m) => ({ ...m, [r.id]: presetKey(r) }));
    }
    setRowError(errors);
    const n = Object.keys(errors).length;
    return n ? `${n} แถวบันทึกไม่สำเร็จ (ดูข้อความในตาราง)` : null;
  }
  useSaveUnit("purpose-presets", "เหตุผลนัด", "appointments", dirty, save);

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
    setAdding(false);
    load();
  }

  const setRow = (i: number, patch: Partial<Preset>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const sort = useDragSort(rows.length, move);

  async function remove(r: Preset) {
    // นัดเดิมไม่หาย (purpose_id → null ข้อความเหตุผลที่บันทึกไว้ในนัดยังอยู่)
    const { error } = await sb.from("appointment_purposes").delete().eq("id", r.id);
    if (error) return flash(`ลบไม่สำเร็จ: ${error.message}`);
    setRows((list) => list.filter((x) => x.id !== r.id));
    load();
  }

  return (
    <SetGroup title="เหตุผลนัด" dirty={dirty} side={<span className="chip">{rows.length} รายการ</span>}
      info={'ลาก ⋮⋮ หรือกด ↑/↓ เพื่อเรียงลำดับ (มีผลทันที) · "นัดอีก (วัน)" = เลือกวันนัดให้อัตโนมัติ · "การปฏิบัติตัว" = ค่าเริ่มต้นที่ส่งในข้อความนัดเสมอ · แก้ชื่อ/วัน/การปฏิบัติตัว/ใช้ แล้วกดบันทึกการตั้งค่า'}>
      <ListSection aligned columns={<><span className="c-handle" /><span className="c-name">เหตุผลนัด</span><span className="c-days">นัดอีก (วัน)</span><span className="c-extra">การปฏิบัติตัว</span><span className="c-switch">ใช้</span><span className="c-menu" /></>}>
        {rows.map((r, i) => (
          <div key={r.id} className={`slist-row preset-row ${r.active ? "" : "off"}`} role="listitem" {...sort.row(i)}>
            <DragHandle {...sort.handle(i, r.name || "เหตุผลนัด")} />
            <input className="slist-input name" aria-label="ชื่อเหตุผลนัด" value={r.name} aria-invalid={!r.name.trim() || !!rowError[r.id] || undefined} onChange={(e) => setRow(i, { name: e.target.value })} />
            <input className="slist-input days" aria-label={`นัดอีกกี่วัน (${r.name})`} type="number" min={1} placeholder="–"
              value={r.default_days ?? ""} onChange={(e) => setRow(i, { default_days: days(e.target.value) })} />
            <input className="slist-input extra" aria-label={`การปฏิบัติตัว (${r.name})`} placeholder="–"
              value={r.reminder_extra_text ?? ""} onChange={(e) => setRow(i, { reminder_extra_text: e.target.value })} />
            <Switch checked={r.active} hideLabel label={`ใช้ ${r.name}`} onChange={(v) => setRow(i, { active: v })} />
            <RowMenu label={`เหตุผลนัด ${r.name}`} items={[{ label: "ลบเหตุผลนัด", danger: true, confirm: `ลบ “${r.name}”? นัดเดิมยังเก็บข้อความเหตุผลไว้ · กู้คืนไม่ได้`, onSelect: () => remove(r) }]} />
            {rowError[r.id] && <div className="error small row-error">{rowError[r.id]}</div>}
          </div>
        ))}
        {adding ? (
          <form className="slist-row preset-row slist-add-form" onSubmit={add} onKeyDown={(e) => { if (e.key === "Escape") { setAdding(false); setDraft({ name: "", default_days: "", reminder_extra_text: "" }); } }}>
            <span className="drag-handle placeholder" aria-hidden="true" />
            <input autoFocus className="slist-input name" aria-label="ชื่อเหตุผลนัดใหม่" placeholder="เหตุผลนัดใหม่" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <input className="slist-input days" aria-label="นัดอีกกี่วัน" type="number" min={1} placeholder="วัน" value={draft.default_days} onChange={(e) => setDraft({ ...draft, default_days: e.target.value })} />
            <input className="slist-input extra" aria-label="การปฏิบัติตัว" placeholder="การปฏิบัติตัว" value={draft.reminder_extra_text} onChange={(e) => setDraft({ ...draft, reminder_extra_text: e.target.value })} />
            <span className="slist-add-actions">
              <button className="btn primary small" disabled={!draft.name.trim()}>เพิ่ม</button>
              <button type="button" className="btn ghost small" onClick={() => { setAdding(false); setDraft({ name: "", default_days: "", reminder_extra_text: "" }); }}>ยกเลิก</button>
            </span>
          </form>
        ) : <button type="button" className="slist-add" onClick={() => setAdding(true)}>+ เพิ่มเหตุผลนัด</button>}
        <span className="sr-only" aria-live="polite">{sort.announce}</span>
      </ListSection>
      {msg && <div className="small slist-msg">{msg}</div>}
    </SetGroup>
  );
}

const normalize = (list: Slot[]) => list.map((s) => ({ ...s, start_time: s.start_time.slice(0, 5), end_time: s.end_time.slice(0, 5) }));

/**
 * เวลาเปิดคลินิก (ช่วงนัด): แสดง 3 แถว จันทร์–ศุกร์ / เสาร์ / อาทิตย์ · สวิตช์ "แยกตั้งรายวัน" ขยายเป็น 7 แถว
 * ถ้าจันทร์–ศุกร์ตั้งไว้ไม่เท่ากัน เปิดแบบรายวันเองและไม่ยุบทับค่า · ฐานข้อมูลเก็บรายวันเหมือนเดิม
 * บันทึกผ่านปุ่ม "บันทึกการตั้งค่า" ของหน้า · วันหยุดพิเศษ เพิ่ม/ลบแล้วมีผลทันที
 */
export function ClinicHoursSettings({ initialSlots = [] }: { initialSlots?: Slot[] } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [slots, setSlots] = useState<Slot[]>(() => normalize(initialSlots));
  const [stored, setStored] = useState(() => hoursSignature(normalize(initialSlots)));
  const [perDay, setPerDay] = useState(() => !weekdaysUniform(initialSlots));
  const [closures, setClosures] = useState<Closure[]>([]);
  const [newClosure, setNewClosure] = useState({ date: "", reason: "" });
  const [msg, setMsg] = useState("");
  const today = bangkokToday();

  const load = useCallback(async () => {
    const [{ data: h }, { data: c }] = await Promise.all([
      sb.from("clinic_hours").select("weekday, slot_id, label, start_time, end_time, sort_order"),
      sb.from("clinic_closures").select("closed_on, reason").gte("closed_on", today).order("closed_on"),
    ]);
    const list = normalize((h ?? []) as Slot[]);
    setSlots(list);
    setStored(hoursSignature(list));
    if (!weekdaysUniform(list)) setPerDay(true);
    setClosures((c ?? []) as Closure[]);
  }, [sb, today]);
  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 4000); };
  const uniform = weekdaysUniform(slots);
  const dirty = hoursSignature(slots) !== stored;

  async function saveHours(): Promise<string | null> {
    const err = validateHours(slots);
    if (err) { flash(err); return err; }
    // เขียนใหม่ทั้งตาราง ตารางเล็ก (ไม่เกิน 7 วัน × ไม่กี่ช่วง)
    const del = await sb.from("clinic_hours").delete().gte("weekday", 0);
    if (del.error) { flash(`บันทึกไม่สำเร็จ: ${del.error.message}`); return del.error.message; }
    if (slots.length) {
      const ins = await sb.from("clinic_hours").insert(slots.map((s) => ({ ...s, label: s.label.trim() })));
      if (ins.error) { flash(`บันทึกไม่สำเร็จ: ${ins.error.message}`); return ins.error.message; }
    }
    setStored(hoursSignature(slots));
    return null;
  }
  useSaveUnit("clinic-hours", "เวลาเปิดคลินิก", "appointments", dirty, saveHours);

  async function addClosure(e: React.FormEvent) {
    e.preventDefault();
    if (!newClosure.date) return;
    const { error } = await sb.from("clinic_closures").upsert({ closed_on: newClosure.date, reason: newClosure.reason.trim() || null });
    if (error) return flash(`เพิ่มไม่สำเร็จ: ${error.message}`);
    setNewClosure({ date: "", reason: "" });
    const { data } = await sb.from("clinic_closures").select("closed_on, reason").gte("closed_on", today).order("closed_on");
    setClosures((data ?? []) as Closure[]);
  }

  async function removeClosure(date: string) {
    await sb.from("clinic_closures").delete().eq("closed_on", date);
    setClosures((list) => list.filter((c) => c.closed_on !== date));
  }

  // แถวที่แสดง: รายวัน 7 แถว หรือกลุ่ม 3 แถว (แถวกลุ่มแก้ทุกวันในกลุ่มพร้อมกัน)
  const rowsToShow = perDay
    ? DAY_ORDER.map((d) => ({ key: String(d), label: DAY_NAME[d], days: [d] }))
    : HOUR_GROUPS;

  return (
    <>
      <SetGroup title="เวลาเปิดคลินิก" dirty={dirty} info="ปุ่มช่วงเวลาในฟอร์มนัดมาจากตารางนี้ · วันที่ไม่มีช่วง = ปิดทั้งวัน · ช่วงเช้า (morning) เป็นค่าเริ่มต้น">
        <SetLine label="แยกตั้งรายวัน" desc={perDay && !uniform ? "จันทร์–ศุกร์ตั้งไม่เท่ากัน ต้องแสดงรายวันเพื่อไม่ให้ค่าถูกทับ" : "ปิด = ตั้งจันทร์–ศุกร์ทีเดียว"}>
          <Switch checked={perDay} disabled={perDay && !uniform} onChange={setPerDay} label={perDay ? "แสดง 7 วัน" : "แสดง 3 แถว"} />
        </SetLine>
        <SetLine label="ช่วงเวลานัด" desc="ใช้กับปุ่มช่วงเวลาในฟอร์มนัดเท่านั้น แยกจาก “เวลาทำการ” (หมวดแชทและแท็ก) ที่ AI ใช้" full>
          <div className="set-table-wrap">
            <table className="set-table hours-grid">
              <thead><tr><th>วัน</th><th>ช่วงเวลา (ชื่อ · เริ่ม–สิ้นสุด)</th><th aria-label="เพิ่มช่วง" /></tr></thead>
              <tbody>
                {rowsToShow.map((g) => {
                  const shown = slotsOfDay(slots, g.days[0]);
                  return (
                    <tr key={g.key}>
                      <th scope="row">{g.label}</th>
                      <td>
                        <div className="hours-slots">
                          {shown.length === 0 && <span className="muted small">ปิดทั้งวัน</span>}
                          {shown.map((s) => (
                            <span key={`${g.key}-${s.slot_id}`} className="hours-slot">
                              <input aria-label={`ชื่อช่วง ${g.label}`} value={s.label} onChange={(e) => setSlots((l) => patchGroupSlot(l, g.days, s.slot_id, { label: e.target.value }))} />
                              <input aria-label={`เริ่ม ${g.label}`} type="time" value={s.start_time} onChange={(e) => setSlots((l) => patchGroupSlot(l, g.days, s.slot_id, { start_time: e.target.value }))} />
                              <span>–</span>
                              <input aria-label={`สิ้นสุด ${g.label}`} type="time" value={s.end_time} onChange={(e) => setSlots((l) => patchGroupSlot(l, g.days, s.slot_id, { end_time: e.target.value }))} />
                              <button type="button" className="icon-btn ghost-icon" aria-label={`ลบ ${s.label} ${g.label}`} onClick={() => setSlots((l) => removeGroupSlot(l, g.days, s.slot_id))}>✕</button>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="actions"><button type="button" className="btn ghost small" onClick={() => setSlots((l) => addGroupSlot(l, g.days))}>+ ช่วง</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {msg && <div className="small" role="status">{msg}</div>}
        </SetLine>
      </SetGroup>

      <SetGroup title="วันหยุดพิเศษ" info="วันที่ปิดทั้งวัน ฟอร์มนัดจะไม่ให้เลือก · เพิ่ม/ลบแล้วมีผลทันที">
        <SetLine label="เพิ่มวันหยุด" desc="วันและเหตุผล (ไม่ใส่ก็ได้)">
          <form className="row set-closure" onSubmit={addClosure}>
            <input type="date" aria-label="วันหยุด" min={today} value={newClosure.date} onChange={(e) => setNewClosure({ ...newClosure, date: e.target.value })} />
            <input aria-label="เหตุผล" placeholder="เช่น วันหยุดสงกรานต์" value={newClosure.reason} onChange={(e) => setNewClosure({ ...newClosure, reason: e.target.value })} />
            <button className="btn ghost" disabled={!newClosure.date}>เพิ่มวันหยุด</button>
          </form>
        </SetLine>
        <SetLine label="วันหยุดที่ตั้งไว้" desc="ตั้งแต่วันนี้เป็นต้นไป">
          {closures.length === 0 && <span className="muted">ยังไม่มี</span>}
          {closures.map((c) => (
            <div key={c.closed_on} className="row closure-row">
              <span>{thaiFullDate(c.closed_on)}{c.reason ? ` — ${c.reason}` : ""}</span>
              <button type="button" className="btn ghost small" onClick={() => removeClosure(c.closed_on)}>ลบ</button>
            </div>
          ))}
        </SetLine>
      </SetGroup>
    </>
  );
}
