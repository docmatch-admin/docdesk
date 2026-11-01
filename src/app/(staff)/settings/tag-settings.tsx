"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { DEFAULT_TAG_COLOR, TAG_GROUP_LABEL, type Tag, type TagGroup, type TagRule } from "@/lib/tags";

const GROUPS = Object.keys(TAG_GROUP_LABEL) as TagGroup[];

/** บันทึกทันทีที่เปลี่ยน ไม่ต้องรอปุ่มบันทึกของหน้าตั้งค่า */
export function TagSettings() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [tags, setTags] = useState<Tag[]>([]);
  const [rules, setRules] = useState<(TagRule & { id: string })[]>([]);
  const [name, setName] = useState("");
  const [group, setGroup] = useState<TagGroup>("topic");
  const [color, setColor] = useState(DEFAULT_TAG_COLOR);
  const [ruleKeyword, setRuleKeyword] = useState("");
  const [ruleTag, setRuleTag] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const [{ data: t }, { data: r }] = await Promise.all([
      sb.from("tags").select("id, name, color, group, sort, active").order("sort").order("name"),
      sb.from("tag_rules").select("id, kind, keyword, tag").order("created_at"),
    ]);
    setTags((t ?? []) as Tag[]);
    setRules((r ?? []) as (TagRule & { id: string })[]);
  }, [sb]);
  useEffect(() => { load(); }, [load]);

  const report = (error: { message: string; code?: string } | null, duplicateText?: string) => {
    setMsg(error ? (error.code === "23505" && duplicateText ? duplicateText : `บันทึกไม่สำเร็จ: ${error.message}`) : "");
    return !error;
  };

  async function addTag(e: React.FormEvent) {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    const sort = Math.max(0, ...tags.filter((t) => t.group === group).map((t) => t.sort)) + 10;
    const { error } = await sb.from("tags").insert({ name: clean, group, color, sort });
    if (report(error, "มีแท็กชื่อนี้แล้ว")) { setName(""); load(); }
  }

  async function patchTag(t: Tag, patch: Partial<Tag>) {
    setTags((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...patch } : x)));
    report((await sb.from("tags").update(patch).eq("id", t.id)).error);
  }

  /** สลับลำดับกับแท็กข้างเคียงในกลุ่มเดียวกัน */
  async function move(t: Tag, dir: -1 | 1) {
    const list = tags.filter((x) => x.group === t.group);
    const other = list[list.indexOf(t) + dir];
    if (!other) return;
    // ค่า sort เท่ากันจะสลับไม่ได้ จึงให้เลขใหม่ทั้งกลุ่ม
    const order = [...list];
    order[list.indexOf(t)] = other;
    order[list.indexOf(other)] = t;
    await Promise.all(order.map((x, i) => sb.from("tags").update({ sort: (i + 1) * 10 }).eq("id", x.id)));
    load();
  }

  async function addRule(e: React.FormEvent) {
    e.preventDefault();
    if (!ruleKeyword.trim() || !ruleTag) return;
    const { error } = await sb.from("tag_rules").insert({ kind: "keyword", keyword: ruleKeyword.trim(), tag: ruleTag });
    if (report(error)) { setRuleKeyword(""); load(); }
  }

  async function patchRule(id: string, patch: Partial<TagRule>) {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    report((await sb.from("tag_rules").update(patch).eq("id", id)).error);
  }

  async function removeRule(id: string) {
    if (report((await sb.from("tag_rules").delete().eq("id", id)).error)) load();
  }

  const tagOptions = tags.filter((t) => t.active);

  return (
    <>
      <section className="card">
        <h3>แท็ก</h3>
        <p className="muted small">เปลี่ยนชื่อแท็กไม่ได้ เพราะแชทและรายงานอ้างอิงตามชื่อ ถ้าไม่ใช้แล้วให้ปิดใช้ แชทเดิมยังเห็นแท็กนี้อยู่</p>
        {GROUPS.map((g) => (
          <div key={g}>
            <div className="muted small tag-pop-group"><b>{TAG_GROUP_LABEL[g]}</b></div>
            {tags.filter((t) => t.group === g).map((t, i, list) => (
              <div key={t.id} className={`tag-row ${t.active ? "" : "off"}`}>
                <input type="color" value={t.color} aria-label={`สีของแท็ก ${t.name}`} onChange={(e) => patchTag(t, { color: e.target.value })} />
                <span className="grow">{t.name}</span>
                <button className="btn ghost small" disabled={i === 0} aria-label={`เลื่อน ${t.name} ขึ้น`} onClick={() => move(t, -1)}>↑</button>
                <button className="btn ghost small" disabled={i === list.length - 1} aria-label={`เลื่อน ${t.name} ลง`} onClick={() => move(t, 1)}>↓</button>
                <label className="raw"><input type="checkbox" checked={t.active} onChange={(e) => patchTag(t, { active: e.target.checked })} /> เปิดใช้</label>
              </div>
            ))}
          </div>
        ))}
        <form className="tag-row" onSubmit={addTag}>
          <input type="color" value={color} aria-label="สีของแท็กใหม่" onChange={(e) => setColor(e.target.value)} />
          <input className="grow" value={name} maxLength={40} placeholder="ชื่อแท็กใหม่" aria-label="ชื่อแท็กใหม่" onChange={(e) => setName(e.target.value)} />
          <select value={group} aria-label="กลุ่มของแท็กใหม่" onChange={(e) => setGroup(e.target.value as TagGroup)}>
            {GROUPS.map((g) => <option key={g} value={g}>{TAG_GROUP_LABEL[g]}</option>)}
          </select>
          <button className="btn primary small">เพิ่มแท็ก</button>
        </form>
        {msg && <div className="error small">{msg}</div>}
      </section>

      <section className="card">
        <h3>กฎติดแท็กอัตโนมัติ</h3>
        <p className="muted small">ไม่ใช้ AI คั่นหลายคำด้วย | เช่น บริษัท|พนักงาน|โรงงาน ถ้าเอาแท็กออกจากแชทเอง กฎจะไม่ติดกลับให้แชทนั้น</p>
        {rules.map((r) => (
          <div key={r.id} className="tag-row">
            {r.kind === "non_thai"
              ? <span className="grow">ข้อความที่ไม่ใช่ภาษาไทย</span>
              : <input className="grow" defaultValue={r.keyword} aria-label="คำสำคัญ" onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== r.keyword) patchRule(r.id, { keyword: v });
                }} />}
            <span aria-hidden>→</span>
            <select value={r.tag} aria-label="แท็กที่จะติด" onChange={(e) => patchRule(r.id, { tag: e.target.value })}>
              {!tagOptions.some((t) => t.name === r.tag) && <option value={r.tag}>{r.tag} (ปิดใช้)</option>}
              {tagOptions.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
            <button className="btn ghost small" onClick={() => removeRule(r.id)}>ลบ</button>
          </div>
        ))}
        <form className="tag-row" onSubmit={addRule}>
          <input className="grow" value={ruleKeyword} placeholder="คำสำคัญใหม่" aria-label="คำสำคัญใหม่" onChange={(e) => setRuleKeyword(e.target.value)} />
          <span aria-hidden>→</span>
          <select value={ruleTag} aria-label="แท็กของกฎใหม่" onChange={(e) => setRuleTag(e.target.value)}>
            <option value="">เลือกแท็ก</option>
            {tagOptions.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
          <button className="btn primary small">เพิ่มกฎ</button>
        </form>
      </section>
    </>
  );
}
