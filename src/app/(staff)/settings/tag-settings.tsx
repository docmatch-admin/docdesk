"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { tagLabel } from "@/lib/sensitive-rules";
import { DEFAULT_TAG_COLOR, NON_THAI_MIN_MESSAGES, TAG_GROUP_LABEL, TAG_NAME_LOCKED, type Tag, type TagGroup, type TagRule } from "@/lib/tags";
import { SetGroup, Switch } from "./settings-save";
import { DragHandle, ListSection, RowMenu, useDragSort } from "./settings-list";
import { tagChipStyle } from "@/lib/tag-colors";

const GROUPS = Object.keys(TAG_GROUP_LABEL) as TagGroup[];
type Rule = TagRule & { id: string };

/**
 * แท็กและกฎติดแท็ก: แก้แล้วมีผลทันที (ไม่รอปุ่มบันทึกของหน้า) · admin และ agent แก้ได้
 * เปลี่ยนชื่อแท็กผ่าน rename_tag ในฐานข้อมูล: เปลี่ยนทุกแชท/กฎ/ประวัติพร้อมกัน (แชทเก็บแท็กเป็นชื่อ)
 * แท็กที่โค้ดใช้ตามชื่อ (TAG_NAME_LOCKED) เปลี่ยนชื่อไม่ได้
 */
export function TagSettings({ initialTags, initialRules }: { initialTags?: Tag[]; initialRules?: Rule[] } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [tags, setTags] = useState<Tag[]>(initialTags ?? []);
  const [rules, setRules] = useState<Rule[]>(initialRules ?? []);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const [{ data: t }, { data: r }] = await Promise.all([
      sb.from("tags").select("id, name, color, group, sort, active").order("sort").order("name"),
      sb.from("tag_rules").select("id, kind, keyword, exclude_keywords, tag").order("created_at"),
    ]);
    setTags((t ?? []) as Tag[]);
    setRules((r ?? []) as Rule[]);
  }, [sb]);
  useEffect(() => { load(); }, [load]);

  const report = (error: { message: string; code?: string } | null, duplicateText?: string) => {
    setMsg(error ? (error.code === "23505" && duplicateText ? duplicateText : `บันทึกไม่สำเร็จ: ${error.message}`) : "");
    return !error;
  };

  async function addTag(group: TagGroup, name: string, color: string) {
    const clean = name.trim();
    if (!clean) return false;
    const sort = Math.max(0, ...tags.filter((t) => t.group === group).map((t) => t.sort)) + 10;
    const ok = report((await sb.from("tags").insert({ name: clean, group, color, sort })).error, "มีแท็กชื่อนี้แล้ว");
    if (ok) load();
    return ok;
  }

  async function patchTag(t: Tag, patch: Partial<Tag>) {
    setTags((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...patch } : x)));
    report((await sb.from("tags").update(patch).eq("id", t.id)).error);
  }

  async function renameTag(t: Tag, name: string): Promise<boolean> {
    const clean = name.replace(/\s+/g, " ").trim();
    if (!clean || clean === t.name) return true;
    const { error } = await sb.rpc("rename_tag", { p_id: t.id, p_name: clean });
    if (error) { setMsg(error.code === "23505" ? "มีแท็กชื่อนี้แล้ว" : `เปลี่ยนชื่อไม่สำเร็จ: ${error.message}`); return false; }
    setMsg("");
    load();
    return true;
  }

  /** ย้ายแท็กในกลุ่มเดียวกัน แล้วให้เลข sort ใหม่ทั้งกลุ่ม */
  async function moveTag(group: TagGroup, from: number, to: number) {
    const order = tags.filter((x) => x.group === group);
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    const sortOf = new Map(order.map((x, i) => [x.id, (i + 1) * 10]));
    setTags((prev) => prev.map((x) => (sortOf.has(x.id) ? { ...x, sort: sortOf.get(x.id)! } : x)).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)));
    const results = await Promise.all(order.map((x, i) => sb.from("tags").update({ sort: (i + 1) * 10 }).eq("id", x.id)));
    if (results.some((r) => r.error)) { setMsg("เรียงลำดับไม่สำเร็จ"); load(); }
  }

  /** ลบได้เฉพาะแท็กที่ยังไม่มีแชทหรือกฎใช้ (แชทเก็บเป็นชื่อ ลบแล้วแชทเดิมจะค้างชื่อที่ไม่มีในรายการ) */
  async function removeTag(t: Tag) {
    const { count, error } = await sb.from("conversations").select("id", { count: "exact", head: true }).contains("tags", [t.name]);
    if (error) return setMsg(`ตรวจการใช้งานไม่สำเร็จ: ${error.message}`);
    const ruleCount = rules.filter((r) => r.tag === t.name).length;
    if ((count ?? 0) > 0 || ruleCount > 0) {
      return setMsg(`ลบ “${t.name}” ไม่ได้: ใช้อยู่ใน ${count ?? 0} แชท${ruleCount ? ` และ ${ruleCount} กฎ` : ""} — ปิดใช้แทน (แชทเดิมยังเห็นแท็กนี้)`);
    }
    if (report((await sb.from("tags").delete().eq("id", t.id)).error)) load();
  }

  async function addRule(keyword: string, exclude: string, tag: string) {
    if (!keyword.trim() || !tag) return false;
    const ok = report((await sb.from("tag_rules").insert({ kind: "keyword", keyword: keyword.trim(), exclude_keywords: exclude.trim(), tag })).error);
    if (ok) load();
    return ok;
  }

  async function patchRule(id: string, patch: Partial<TagRule>) {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    report((await sb.from("tag_rules").update(patch).eq("id", id)).error);
  }

  async function removeRule(id: string) {
    if (report((await sb.from("tag_rules").delete().eq("id", id)).error)) load();
  }

  const tagOptions = tags.filter((t) => t.active);
  const colorOf = (name: string) => tags.find((t) => t.name === name)?.color;

  return (
    <>
      <SetGroup title="แท็ก" area="tags" side={<span className="chip">{tags.length} แท็ก</span>}
        info="คลิกจุดสีเพื่อเปลี่ยนสี · คลิกชื่อเพื่อเปลี่ยนชื่อ (แชทเดิมเปลี่ยนตามทั้งหมด) · ลาก ⋮⋮ หรือกด ↑/↓ เพื่อเรียงลำดับ · แท็กที่มีกุญแจระบบใช้ตามชื่อ เปลี่ยนชื่อไม่ได้ · ทุกอย่างมีผลทันที">
        {msg && <p className="error small slist-msg" role="alert">{msg}</p>}
        {GROUPS.map((g) => (
          <TagGroupList key={g} group={g} tags={tags.filter((t) => t.group === g)}
            onMove={(from, to) => moveTag(g, from, to)} onPatch={patchTag} onRename={renameTag} onRemove={removeTag} onAdd={(name, color) => addTag(g, name, color)} />
        ))}
      </SetGroup>

      <SetGroup title="กฎติดแท็กอัตโนมัติ" area="tagRules" side={<span className="chip">{rules.length} กฎ</span>}
        info="ไม่ใช้ AI คั่นหลายคำด้วย | เช่น พนักงาน|โรงงาน ถ้าข้อความมีคำยกเว้นจะไม่ติดแท็ก ถ้าเอาแท็กออกจากแชทเอง กฎจะไม่ติดกลับให้แชทนั้น · แก้แล้วมีผลทันที">
        <ListSection aligned columns={<><span className="c-grow">คำสำคัญ</span><span className="c-grow">คำยกเว้น</span><span className="c-arrow" /><span className="c-tag">แท็กที่ติด</span><span className="c-menu" /></>}>
          {rules.map((r) => (
            <div key={r.id} className="slist-row rule-row" role="listitem">
              {r.kind === "non_thai"
                ? <span className="slist-main rule-span">ลูกค้าใช้ภาษาอื่นอย่างน้อย {NON_THAI_MIN_MESSAGES} ข้อความ</span>
                : <>
                    <input className="slist-input" defaultValue={r.keyword} aria-label="คำสำคัญ" placeholder="คำสำคัญ" onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== r.keyword) patchRule(r.id, { keyword: v });
                    }} />
                    <input className="slist-input" defaultValue={r.exclude_keywords ?? ""} aria-label="คำยกเว้น" placeholder="ไม่มี" onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (r.exclude_keywords ?? "")) patchRule(r.id, { exclude_keywords: v });
                    }} />
                  </>}
              <span className="rule-arrow" aria-hidden>→</span>
              <span className="rule-tag">
                <i className="rule-tag-dot" style={{ background: colorOf(r.tag) ?? DEFAULT_TAG_COLOR }} aria-hidden />
                <select value={r.tag} aria-label="แท็กที่จะติด" onChange={(e) => patchRule(r.id, { tag: e.target.value })}>
                  {!tagOptions.some((t) => t.name === r.tag) && <option value={r.tag}>{r.tag} (ปิดใช้)</option>}
                  {tagOptions.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                </select>
              </span>
              <RowMenu label={`กฎ ${r.keyword || r.tag}`} items={[{ label: "ลบกฎ", danger: true, confirm: "ลบกฎนี้? กู้คืนไม่ได้", onSelect: () => removeRule(r.id) }]} />
            </div>
          ))}
          <AddRuleRow tags={tagOptions} onAdd={addRule} />
        </ListSection>
      </SetGroup>
    </>
  );
}

function TagGroupList({ group, tags, onMove, onPatch, onRename, onRemove, onAdd }: {
  group: TagGroup; tags: Tag[]; onMove: (from: number, to: number) => void;
  onPatch: (t: Tag, patch: Partial<Tag>) => void; onRename: (t: Tag, name: string) => Promise<boolean>;
  onRemove: (t: Tag) => void; onAdd: (name: string, color: string) => Promise<boolean>;
}) {
  const sort = useDragSort(tags.length, onMove);
  return (
    <ListSection title={TAG_GROUP_LABEL[group]} count={tags.length} unit="แท็ก" columns={<span>เปิดใช้</span>}>
      {tags.map((t, i) => (
        <div key={t.id} className={`slist-row ${t.active ? "" : "off"}`} role="listitem" {...sort.row(i)}>
          <DragHandle {...sort.handle(i, t.name)} />
          <span className="tag-chip settings-tag-chip" style={tagChipStyle(t.color) as React.CSSProperties}>
            <label className="tag-dot-btn" title={`เปลี่ยนสีแท็ก ${t.name}`}>
              <i aria-hidden />
              <input type="color" className="sr-only" value={t.color} aria-label={`สีของแท็ก ${t.name}`} onChange={(e) => onPatch(t, { color: e.target.value })} />
            </label>
            {TAG_NAME_LOCKED.includes(t.name)
              ? <span className="tag-name-locked" title="ระบบใช้แท็กนี้ตามชื่อ เปลี่ยนชื่อไม่ได้">{tagLabel(t.name)} <span aria-label="เปลี่ยนชื่อไม่ได้">🔒</span></span>
              : <TagNameInput key={t.name} tag={t} onRename={onRename} />}
          </span>
          <span className="slist-spacer" />
          <Switch checked={t.active} hideLabel label={`เปิดใช้แท็ก ${t.name}`} onChange={(v) => onPatch(t, { active: v })} />
          <RowMenu label={`แท็ก ${t.name}`} items={[{ label: "ลบแท็ก", danger: true, confirm: `ลบแท็ก “${t.name}”? กู้คืนไม่ได้ (ลบได้เฉพาะแท็กที่ยังไม่มีแชทใช้)`, onSelect: () => onRemove(t) }]} />
        </div>
      ))}
      <AddTagRow group={group} onAdd={onAdd} />
      <span className="sr-only" aria-live="polite">{sort.announce}</span>
    </ListSection>
  );
}

/** ชื่อแท็กแก้ inline: Enter/ออกจากช่อง = บันทึก · Esc = ยกเลิก */
function TagNameInput({ tag, onRename }: { tag: Tag; onRename: (t: Tag, name: string) => Promise<boolean> }) {
  const [v, setV] = useState(tag.name);
  const commit = async () => { if (!(await onRename(tag, v))) setV(tag.name); };
  return (
    <input className="tag-name-input" value={v} maxLength={40} aria-label={`ชื่อแท็ก ${tag.name}`} size={Math.max(4, v.length + 1)}
      onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") { setV(tag.name); (e.target as HTMLInputElement).blur(); } }} />
  );
}

/** "+ เพิ่มแท็ก" ท้ายกลุ่ม กดแล้วกลายเป็นแถวกรอกชื่อ (Enter เพิ่ม · Esc ยกเลิก) */
function AddTagRow({ group, onAdd }: { group: TagGroup; onAdd: (name: string, color: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_TAG_COLOR);
  if (!open) return <button type="button" className="slist-add" onClick={() => setOpen(true)}>+ เพิ่มแท็ก</button>;
  const close = () => { setOpen(false); setName(""); };
  return (
    <form className="slist-row slist-add-form" onSubmit={async (e) => { e.preventDefault(); if (await onAdd(name, color)) close(); }}
      onKeyDown={(e) => { if (e.key === "Escape") close(); }}>
      <span className="drag-handle placeholder" aria-hidden="true" />
      <span className="tag-chip settings-tag-chip editing" style={tagChipStyle(color) as React.CSSProperties}>
        <label className="tag-dot-btn" title="เลือกสีแท็กใหม่">
          <i aria-hidden />
          <input type="color" className="sr-only" value={color} aria-label="สีของแท็กใหม่" onChange={(e) => setColor(e.target.value)} />
        </label>
        <input autoFocus value={name} maxLength={40} placeholder={`แท็กใหม่ใน${TAG_GROUP_LABEL[group]}`} aria-label={`ชื่อแท็กใหม่ใน${TAG_GROUP_LABEL[group]}`} onChange={(e) => setName(e.target.value)} />
      </span>
      <span className="slist-spacer" />
      <button className="btn primary small" disabled={!name.trim()}>เพิ่ม</button>
      <button type="button" className="btn ghost small" onClick={close}>ยกเลิก</button>
    </form>
  );
}

function AddRuleRow({ tags, onAdd }: { tags: Tag[]; onAdd: (keyword: string, exclude: string, tag: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [exclude, setExclude] = useState("");
  const [tag, setTag] = useState("");
  if (!open) return <button type="button" className="slist-add" onClick={() => setOpen(true)}>+ เพิ่มกฎ</button>;
  const close = () => { setOpen(false); setKeyword(""); setExclude(""); setTag(""); };
  return (
    <form className="slist-row rule-row slist-add-form" onSubmit={async (e) => { e.preventDefault(); if (await onAdd(keyword, exclude, tag)) close(); }}
      onKeyDown={(e) => { if (e.key === "Escape") close(); }}>
      <input autoFocus className="slist-input" value={keyword} placeholder="คำสำคัญ" aria-label="คำสำคัญของกฎใหม่" onChange={(e) => setKeyword(e.target.value)} />
      <input className="slist-input" value={exclude} placeholder="คำยกเว้น (ไม่ใส่ก็ได้)" aria-label="คำยกเว้นของกฎใหม่" onChange={(e) => setExclude(e.target.value)} />
      <span className="rule-arrow" aria-hidden>→</span>
      <span className="rule-tag">
        <select value={tag} aria-label="แท็กของกฎใหม่" onChange={(e) => setTag(e.target.value)}>
          <option value="">เลือกแท็ก</option>
          {tags.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
        </select>
      </span>
      <span className="slist-add-actions">
        <button className="btn primary small" disabled={!keyword.trim() || !tag}>เพิ่ม</button>
        <button type="button" className="btn ghost small" onClick={close}>ยกเลิก</button>
      </span>
    </form>
  );
}
