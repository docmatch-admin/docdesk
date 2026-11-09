"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { bangkokToday, thaiFullDate } from "@/lib/appointment-rules";
import {
  DAY_NAME, DAY_ORDER, HOUR_GROUPS, addGroupSlot, hoursSignature, patchGroupSlot, removeGroupSlot, slotsOfDay, validateHours, weekdaysUniform,
  type HourSlot,
} from "@/lib/clinic-hours-group";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { InfoTip } from "./info-tip";
import { useSaveUnit } from "./settings-save";

export interface Preset { id: string; name: string; default_days: number | null; reminder_extra_text: string | null; sort_order: number; active: boolean }
export type Slot = HourSlot;
interface Closure { closed_on: string; reason: string | null }

/** สถานะบันทึกรายแถว: กำลังบันทึก / บันทึกแล้ว / ข้อความ error */
type RowStatus = { kind: "saving" } | { kind: "ok" } | { kind: "error"; text: string };

const presetKey = (r: Preset) => JSON.stringify([r.name.trim(), r.default_days, r.reminder_extra_text?.trim() || null, r.active]);

/**
 * preset เหตุผลนัด: พับเป็นค่าเริ่มต้น (สรุป "เหตุผลนัด · N รายการ") เปิดเองเมื่อมีแถวที่ยังไม่ครบ
 * แก้แล้วบันทึกอัตโนมัติเมื่อออกจากช่อง แสดงผลข้างแถวนั้น · ลากเรียง/↑↓ บันทึกทันที
 */
export function PurposePresets({ initial = [] }: { initial?: Preset[] } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  // initial: ข้อมูลตั้งต้นก่อนโหลด (ภาพตัวอย่าง/เทสต์) หน้าใช้งานจริงโหลดจากฐานข้อมูลเสมอ
  const [rows, setRows] = useState<Preset[]>(initial);
  const [saved, setSaved] = useState<Record<string, string>>(() => Object.fromEntries(initial.map((r) => [r.id, presetKey(r)])));
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const incomplete = rows.some((r) => !r.name.trim());
  const [open, setOpen] = useState(incomplete);
  const [drag, setDrag] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const [draft, setDraft] = useState({ name: "", default_days: "", reminder_extra_text: "" });

  const load = useCallback(async () => {
    const { data } = await sb.from("appointment_purposes").select("id, name, default_days, reminder_extra_text, sort_order, active").order("sort_order");
    const list = (data ?? []) as Preset[];
    setRows(list);
    setSaved(Object.fromEntries(list.map((r) => [r.id, presetKey(r)])));
    if (list.some((r) => !r.name.trim())) setOpen(true);
  }, [sb]);
  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3000); };
  const days = (v: string) => (v.trim() && Number(v) > 0 ? Math.min(3650, Math.floor(Number(v))) : null);
  const setRowStatus = (id: string, s: RowStatus | null) => setStatus((m) => {
    const next = { ...m };
    if (s) next[id] = s; else delete next[id];
    return next;
  });

  /** บันทึกแถวเมื่อค่าเปลี่ยนจากที่บันทึกไว้ (เรียกตอน blur หรือกดติ๊ก "ใช้") */
  async function saveRow(r: Preset) {
    if (saved[r.id] === presetKey(r)) return;
    if (!r.name.trim()) return setRowStatus(r.id, { kind: "error", text: "ต้องมีชื่อเหตุผลนัด" });
    setRowStatus(r.id, { kind: "saving" });
    const { error } = await sb.from("appointment_purposes").update({
      name: r.name.trim(), default_days: r.default_days, reminder_extra_text: r.reminder_extra_text?.trim() || null, active: r.active, updated_at: new Date().toISOString(),
    }).eq("id", r.id);
    if (error) return setRowStatus(r.id, { kind: "error", text: error.code === "23505" ? "มีชื่อนี้แล้ว" : `บันทึกไม่สำเร็จ: ${error.message}` });
    setSaved((m) => ({ ...m, [r.id]: presetKey(r) }));
    setRowStatus(r.id, { kind: "ok" });
    setTimeout(() => setStatus((m) => (m[r.id]?.kind === "ok" ? (({ [r.id]: _, ...rest }) => rest)(m) : m)), 4000);
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
  const active = rows.filter((r) => r.active).length;

  return (
    <details className="appt-settings-block set-fold preset-fold" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <b>เหตุผลนัด · {rows.length} รายการ</b>
        <span className="muted small">{active < rows.length ? `ใช้อยู่ ${active}` : "ใช้ทั้งหมด"}{incomplete ? " · มีแถวที่ยังไม่ครบ" : ""}</span>
        <InfoTip text={'ลาก ⋮⋮ หรือกด ↑↓ เพื่อเรียงลำดับ · "นัดอีก (วัน)" = เลือกวันนัดให้อัตโนมัติ · "การปฏิบัติตัว" = ค่าเริ่มต้นที่ส่งในข้อความนัดเสมอ · แก้แล้วบันทึกอัตโนมัติเมื่อออกจากช่อง'} />
      </summary>
      <div className="set-table-wrap">
        <table className="set-table preset-table">
          <thead>
            <tr><th aria-label="ลากเรียง" /><th>เหตุผลนัด</th><th>นัดอีก (วัน)</th><th>การปฏิบัติตัว</th><th>ใช้</th><th aria-label="เรียงลำดับและสถานะ" /></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const st = status[r.id];
              return (
                <tr key={r.id} className={`${r.active ? "" : "off"} ${drag === i ? "dragging" : ""}`} draggable
                  onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDragEnd={() => setDrag(null)}
                  onDrop={(e) => { e.preventDefault(); if (drag !== null) move(drag, i); setDrag(null); }}>
                  <td className="preset-handle" aria-hidden="true">⋮⋮</td>
                  <td><input aria-label="ชื่อเหตุผลนัด" value={r.name} aria-invalid={!r.name.trim() || undefined}
                    onChange={(e) => setRow(i, { name: e.target.value })} onBlur={() => saveRow(r)} /></td>
                  <td className="num"><input aria-label="นัดอีกกี่วัน" type="number" min={1} placeholder="–"
                    value={r.default_days ?? ""} onChange={(e) => setRow(i, { default_days: days(e.target.value) })} onBlur={() => saveRow(r)} /></td>
                  <td><input aria-label="การปฏิบัติตัว" placeholder="–"
                    value={r.reminder_extra_text ?? ""} onChange={(e) => setRow(i, { reminder_extra_text: e.target.value })} onBlur={() => saveRow(r)} /></td>
                  <td className="center"><input type="checkbox" aria-label={`ใช้ ${r.name}`} checked={r.active}
                    onChange={(e) => { const next = { ...r, active: e.target.checked }; setRow(i, { active: next.active }); saveRow(next); }} /></td>
                  <td className="actions">
                    <button type="button" className="icon-btn ghost-icon" aria-label={`เลื่อน ${r.name} ขึ้น`} disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
                    <button type="button" className="icon-btn ghost-icon" aria-label={`เลื่อน ${r.name} ลง`} disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}>↓</button>
                    <span className={`row-status ${st?.kind ?? ""}`} role="status" aria-live="polite">
                      {st?.kind === "saving" ? "กำลังบันทึก…" : st?.kind === "ok" ? "✓ บันทึกแล้ว" : st?.kind === "error" ? st.text : ""}
                    </span>
                  </td>
                </tr>
              );
            })}
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
    </details>
  );
}

const normalize = (list: Slot[]) => list.map((s) => ({ ...s, start_time: s.start_time.slice(0, 5), end_time: s.end_time.slice(0, 5) }));

/**
 * เวลาเปิดคลินิก (ช่วงนัด): แสดง 3 แถว จันทร์–ศุกร์ / เสาร์ / อาทิตย์ · สวิตช์ "แยกตั้งรายวัน" ขยายเป็น 7 แถว
 * ถ้าจันทร์–ศุกร์ตั้งไว้ไม่เท่ากัน เปิดแบบรายวันเองและไม่ยุบทับค่า · ฐานข้อมูลเก็บรายวันเหมือนเดิม
 * บันทึกผ่านปุ่ม "บันทึกการตั้งค่า" ของหน้า · วันหยุดพิเศษ เพิ่ม/ลบแล้วบันทึกทันที
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
    flash("บันทึกเวลาเปิดแล้ว ✓");
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
    <div className="appt-settings-block">
      <div className="set-block-head">
        <h3>เวลาเปิดคลินิก (ช่วงนัด) <InfoTip text="ปุ่มช่วงเวลาในฟอร์มนัดมาจากตารางนี้ · วันที่ไม่มีช่วง = ปิดทั้งวัน · ช่วงเช้า (morning) เป็นค่าเริ่มต้น · บันทึกด้วยปุ่ม &quot;บันทึกการตั้งค่า&quot; ด้านล่าง" /></h3>
        <label className="switch-row small" title={!uniform ? "จันทร์–ศุกร์ตั้งไว้ไม่เท่ากัน ต้องแสดงรายวันเพื่อไม่ให้ค่าถูกทับ" : undefined}>
          <input type="checkbox" role="switch" checked={perDay} disabled={perDay && !uniform}
            onChange={(e) => setPerDay(e.target.checked)} />
          แยกตั้งรายวัน
        </label>
      </div>
      {perDay && !uniform && <p className="muted small set-note">จันทร์–ศุกร์ตั้งเวลาไม่เท่ากัน จึงแสดงรายวัน (ตั้งให้เท่ากันก่อนจึงยุบรวมได้)</p>}
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
      <p className="muted small set-other-note">ตารางนี้ใช้กับปุ่มช่วงเวลาในฟอร์มนัดเท่านั้น แยกจาก &quot;เวลาทำการ&quot; (แท็บแชทและแท็ก) ที่ AI ใช้ตอบลูกค้า</p>
      <form className="row set-closure" onSubmit={addClosure}>
        <b className="small">วันหยุดพิเศษ</b>
        <input type="date" aria-label="วันหยุด" min={today} value={newClosure.date} onChange={(e) => setNewClosure({ ...newClosure, date: e.target.value })} style={{ width: "auto" }} />
        <input aria-label="เหตุผล" placeholder="เช่น วันหยุดสงกรานต์" value={newClosure.reason} onChange={(e) => setNewClosure({ ...newClosure, reason: e.target.value })} style={{ flex: 1, width: "auto" }} />
        <button className="btn ghost" disabled={!newClosure.date}>เพิ่มวันหยุด</button>
      </form>

      {closures.map((c) => (
        <div key={c.closed_on} className="row small">
          <span>{thaiFullDate(c.closed_on)}{c.reason ? ` — ${c.reason}` : ""}</span>
          <button type="button" className="btn ghost small" onClick={() => removeClosure(c.closed_on)}>ลบ</button>
        </div>
      ))}
      {msg && <div className="small" role="status">{msg}</div>}
    </div>
  );
}
