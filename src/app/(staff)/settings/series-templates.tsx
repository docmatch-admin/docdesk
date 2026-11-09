"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

interface TemplateItem { label: string; offset_value: number; offset_unit: "day" | "week" | "month"; from: "first" | "previous" }
interface Template { id?: string; name: string; purpose_id: string | null; items: TemplateItem[]; active: boolean; sort_order: number }

const UNIT_TH = { day: "วัน", week: "สัปดาห์", month: "เดือน" } as const;
const emptyTemplate = (): Template => ({ name: "", purpose_id: null, active: true, sort_order: 0, items: [{ label: "เข็ม 1", offset_value: 0, offset_unit: "day", from: "first" }] });

/** template ชุดนัด (เช่น วัคซีนหลายเข็ม) แอดมิน/แพทย์สร้างเอง รายการแรกนับจากวันที่ทำนัด */
export function SeriesTemplates() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [rows, setRows] = useState<Template[]>([]);
  const [purposes, setPurposes] = useState<{ id: string; name: string }[]>([]);
  const [editing, setEditing] = useState<Template | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const [{ data: t }, { data: p }] = await Promise.all([
      sb.from("appointment_series_templates").select("id, name, purpose_id, items, active, sort_order").order("sort_order"),
      sb.from("appointment_purposes").select("id, name").eq("active", true).order("sort_order"),
    ]);
    setRows((t ?? []) as Template[]);
    setPurposes((p ?? []) as { id: string; name: string }[]);
  }, [sb]);
  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3000); };

  async function save() {
    if (!editing) return;
    if (!editing.name.trim()) return flash("ตั้งชื่อ template");
    if (editing.items.length < 2) return flash("ชุดนัดต้องมีอย่างน้อย 2 นัด");
    const body = {
      name: editing.name.trim(), purpose_id: editing.purpose_id || null, active: editing.active, updated_at: new Date().toISOString(),
      items: editing.items.map((it, i) => ({ ...it, label: it.label.trim() || `เข็ม ${i + 1}`, offset_value: Math.max(0, Math.floor(Number(it.offset_value) || 0)) })),
    };
    const { error } = editing.id
      ? await sb.from("appointment_series_templates").update(body).eq("id", editing.id)
      : await sb.from("appointment_series_templates").insert({ ...body, sort_order: (rows.at(-1)?.sort_order ?? 0) + 10 });
    if (error) return flash(`บันทึกไม่สำเร็จ: ${error.message}`);
    setEditing(null);
    flash("บันทึกแล้ว ✓");
    load();
  }

  async function remove(id: string) {
    await sb.from("appointment_series_templates").delete().eq("id", id);
    load();
  }

  const setItem = (i: number, patch: Partial<TemplateItem>) =>
    setEditing((t) => (t ? { ...t, items: t.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) } : t));

  return (
    <div className="appt-settings-block">
      <h3>Template ชุดนัด</h3>
      <p className="muted small">เช่น วัคซีนหลายเข็ม — นัดแรกนับจากวันที่ทำนัด นัดถัดไปนับจากนัดแรกหรือนัดก่อนหน้า (ระบบไม่ได้ใส่ตารางวัคซีนให้ สร้างเองตามแนวทางของคลินิก)</p>
      {rows.map((t) => (
        <div key={t.id} className={`preset-row ${t.active ? "" : "off"}`}>
          <b style={{ flex: 1 }}>{t.name}</b>
          <span className="muted small">{t.items.map((it, i) => (i === 0 ? it.label : `${it.label} +${it.offset_value} ${UNIT_TH[it.offset_unit]}`)).join(" → ")}</span>
          <button type="button" className="btn ghost small" onClick={() => setEditing(structuredClone(t))}>แก้ไข</button>
          <button type="button" className="btn ghost small danger" onClick={() => t.id && remove(t.id)}>ลบ</button>
        </div>
      ))}
      {!editing && <button type="button" className="btn ghost small" onClick={() => setEditing(emptyTemplate())}>+ สร้าง template ชุดนัด</button>}
      {editing && (
        <div className="template-editor">
          <div className="row">
            <input aria-label="ชื่อ template" placeholder="ชื่อ เช่น วัคซีน 3 เข็ม" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} style={{ flex: 1, width: "auto" }} />
            <select aria-label="เหตุผลนัด" value={editing.purpose_id ?? ""} onChange={(e) => setEditing({ ...editing, purpose_id: e.target.value || null })} style={{ width: "auto" }}>
              <option value="">— เหตุผลนัด —</option>
              {purposes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <label className="raw small"><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> ใช้</label>
          </div>
          {editing.items.map((it, i) => (
            <div key={i} className="preset-row">
              <input aria-label={`ชื่อนัดที่ ${i + 1}`} value={it.label} onChange={(e) => setItem(i, { label: e.target.value })} style={{ width: 110 }} />
              <span className="small muted">{i === 0 ? "อีก" : "+"}</span>
              <input aria-label="จำนวน" type="number" min={0} className="preset-days" value={it.offset_value} onChange={(e) => setItem(i, { offset_value: Number(e.target.value) })} />
              <select aria-label="หน่วย" value={it.offset_unit} onChange={(e) => setItem(i, { offset_unit: e.target.value as TemplateItem["offset_unit"] })} style={{ width: "auto" }}>
                {(Object.keys(UNIT_TH) as TemplateItem["offset_unit"][]).map((u) => <option key={u} value={u}>{UNIT_TH[u]}</option>)}
              </select>
              {i === 0 ? <span className="small muted">จากวันที่ทำนัด</span> : (
                <select aria-label="นับจาก" value={it.from} onChange={(e) => setItem(i, { from: e.target.value as TemplateItem["from"] })} style={{ width: "auto" }}>
                  <option value="first">นับจากนัดแรก</option>
                  <option value="previous">นับจากนัดก่อนหน้า</option>
                </select>
              )}
              {i > 0 && <button type="button" className="btn ghost small" aria-label={`ลบ ${it.label}`} onClick={() => setEditing({ ...editing, items: editing.items.filter((_, j) => j !== i) })}>✕</button>}
            </div>
          ))}
          <div className="row">
            <button type="button" className="btn ghost small" onClick={() => setEditing({ ...editing, items: [...editing.items, { label: `เข็ม ${editing.items.length + 1}`, offset_value: 1, offset_unit: "month", from: "previous" }] })}>+ เพิ่มนัด</button>
            <button type="button" className="btn primary small" onClick={save}>บันทึก template</button>
            <button type="button" className="btn ghost small" onClick={() => setEditing(null)}>ยกเลิก</button>
          </div>
        </div>
      )}
      {msg && <div className="small">{msg}</div>}
    </div>
  );
}
