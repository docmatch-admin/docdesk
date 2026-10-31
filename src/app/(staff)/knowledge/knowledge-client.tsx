"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

interface Item { id: string; category: string; title: string; content: string; active: boolean; updated_at: string }
interface Example { id: string; question: string; answer: string; starred: boolean; use_count: number; active: boolean; created_at: string }

const dateTh = (iso: string) => new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" });
const EMPTY = { id: "", category: "", title: "", content: "" };

export function KnowledgeClient() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [tab, setTab] = useState<"kb" | "ex">("kb");
  const [items, setItems] = useState<Item[]>([]);
  const [examples, setExamples] = useState<Example[]>([]);
  const [q, setQ] = useState("");
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(async () => {
    const [{ data: k }, { data: e }] = await Promise.all([
      sb.from("knowledge_items").select("id, category, title, content, active, updated_at").order("category").order("title"),
      sb.from("reply_examples").select("id, question, answer, starred, use_count, active, created_at")
        .order("starred", { ascending: false }).order("use_count", { ascending: false }).order("created_at", { ascending: false }).limit(500),
    ]);
    setItems((k ?? []) as Item[]);
    setExamples((e ?? []) as Example[]);
  }, [sb]);
  useEffect(() => { load(); }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await fetch("/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, id: form.id || undefined }),
    });
    setSaving(false);
    if (!res.ok) return setMsg((await res.json()).error ?? "บันทึกไม่สำเร็จ");
    setForm(EMPTY);
    setMsg("บันทึกแล้ว AI จะใช้ข้อมูลนี้ทันที");
    load();
  }

  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
  const categories = [...new Set(items.map((i) => i.category))];
  const kb = items.filter((i) => match(`${i.category} ${i.title} ${i.content}`));
  const ex = examples.filter((x) => (showHidden || x.active) && match(`${x.question} ${x.answer}`));

  return (
    <div className="page">
      <h1>ฐานข้อมูล &amp; คำตอบที่เรียนรู้</h1>
      <p className="muted">AI ใช้ฐานข้อมูลคลินิกเป็นแหล่งหลัก (ข้อมูลล่าสุดเสมอ) และใช้คำตอบเดิมของเจ้าหน้าที่เป็นแบบอย่างสำนวน</p>

      <div className="tabs wide">
        <button className={tab === "kb" ? "on" : ""} onClick={() => setTab("kb")}>📚 ฐานข้อมูลคลินิก ({items.length})</button>
        <button className={tab === "ex" ? "on" : ""} onClick={() => setTab("ex")}>💬 คำตอบที่เรียนรู้ ({examples.filter((x) => x.active).length})</button>
        <input className="search" placeholder="ค้นหา…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {tab === "kb" ? (
        <div className="kb-grid">
          <form className="card form" onSubmit={save}>
            <h3>{form.id ? "แก้ไขข้อมูล" : "เพิ่มข้อมูลใหม่"}</h3>
            <label>หมวด
              <input list="cats" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="เช่น วัคซีน" />
              <datalist id="cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
            </label>
            <label>หัวข้อ<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label>
            <label>รายละเอียด (ราคา เงื่อนไข เวลา)
              <textarea rows={6} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} required />
            </label>
            {msg && <div className="muted small">{msg}</div>}
            <div className="row">
              <button className="btn primary" disabled={saving}>{saving ? "กำลังบันทึก…" : "บันทึก"}</button>
              {form.id && <button type="button" className="btn ghost" onClick={() => setForm(EMPTY)}>ยกเลิก</button>}
            </div>
          </form>

          <div className="kb-list">
            {kb.map((i) => (
              <div key={i.id} className={`card kb-item ${i.active ? "" : "off"}`}>
                <div className="row between">
                  <div><span className="chip">{i.category}</span> <b>{i.title}</b></div>
                  <div className="row">
                    <button className="btn ghost small" onClick={() => setForm({ id: i.id, category: i.category, title: i.title, content: i.content })}>แก้ไข</button>
                    <button className="btn ghost small" onClick={async () => {
                      await sb.from("knowledge_items").update({ active: !i.active }).eq("id", i.id); load();
                    }}>{i.active ? "ปิดใช้" : "เปิดใช้"}</button>
                  </div>
                </div>
                <div className="pre">{i.content}</div>
                <div className="muted small">อัปเดต {dateTh(i.updated_at)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <label className="raw"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> แสดงที่ซ่อนแล้ว</label>
          {ex.length === 0 && <div className="empty">ยังไม่มีคำตอบที่เรียนรู้ — ระบบจะเก็บอัตโนมัติทุกครั้งที่เจ้าหน้าที่ตอบ</div>}
          {ex.map((x) => (
            <ExampleRow key={x.id} x={x} onChange={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function ExampleRow({ x, onChange }: { x: Example; onChange: () => void }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState(x.answer);
  return (
    <div className={`card ex-item ${x.active ? "" : "off"}`}>
      <div className="row between">
        <div className="muted small">
          {x.starred && "⭐ คำตอบมาตรฐาน · "}ถูกเลือกใช้ {x.use_count} ครั้ง · {dateTh(x.created_at)}
        </div>
        <div className="row">
          <button className="btn ghost small" onClick={async () => {
            await sb.from("reply_examples").update({ starred: !x.starred }).eq("id", x.id); onChange();
          }}>{x.starred ? "เอาดาวออก" : "☆ ตั้งเป็นมาตรฐาน"}</button>
          <button className="btn ghost small" onClick={() => setEditing(!editing)}>แก้คำตอบ</button>
          <button className="btn ghost small" onClick={async () => {
            await sb.from("reply_examples").update({ active: !x.active }).eq("id", x.id); onChange();
          }}>{x.active ? "ซ่อน (ข้อมูลเก่า)" : "ใช้อีกครั้ง"}</button>
        </div>
      </div>
      <div><b>ถาม:</b> {x.question}</div>
      {editing ? (
        <div>
          <textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          <button className="btn primary small" onClick={async () => {
            await sb.from("reply_examples").update({ answer }).eq("id", x.id); setEditing(false); onChange();
          }}>บันทึก</button>
        </div>
      ) : (
        <div><b>ตอบ:</b> {x.answer}</div>
      )}
    </div>
  );
}
