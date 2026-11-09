"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { MAX_UPLOAD_BYTES, uploadStaffImage } from "@/lib/upload-client";
import { LabPricesPanel } from "./lab-prices-panel";

interface Item { id: string; category: string; title: string; content: string; active: boolean; updated_at: string; source: string; review_status: string }
const GUIDE_CATEGORY = "แนวทางซักอาการ";
interface SyncStatus { last_success_at: string | null; error: string | null; needs_confirm?: boolean; count?: number; pages?: number; pages_error?: string | null }
interface Example { id: string; question: string; answer: string; starred: boolean; use_count: number; active: boolean; created_at: string; source?: string; import_batch_id?: string | null }

const dateTh = (iso: string) => new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" });
const timeTh = (iso: string) => new Date(iso).toLocaleString("th-TH", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", timeZone: "Asia/Bangkok" });
const EMPTY = { id: "", category: "", title: "", content: "" };

export function KnowledgeClient({ embedded = false }: { embedded?: boolean } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [tab, setTab] = useState<"kb" | "ex" | "media" | "lab">("kb");
  const [items, setItems] = useState<Item[]>([]);
  const [examples, setExamples] = useState<Example[]>([]);
  const [q, setQ] = useState("");
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [onlyImported, setOnlyImported] = useState(false);
  const [confirmHide, setConfirmHide] = useState(false);
  const [imported, setImported] = useState<Example[]>([]);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const [{ data: k }, { data: e }] = await Promise.all([
      sb.from("knowledge_items").select("id, category, title, content, active, updated_at, source, review_status").order("category").order("title"),
      sb.from("reply_examples").select("id, question, answer, starred, use_count, active, created_at")
        .order("starred", { ascending: false }).order("use_count", { ascending: false }).order("created_at", { ascending: false }).limit(500),
    ]);
    setItems((k ?? []) as Item[]);
    setExamples((e ?? []) as Example[]);
    // แยกดึง คำตอบที่นำเข้าหรือวางใช้งานน้อยจึงอาจตกจาก 500 แถวแรก
    const { data: i } = await sb.from("reply_examples").select("id, question, answer, starred, use_count, active, created_at, source, import_batch_id")
      .in("source", ["line_import", "manual_paste"]).order("created_at", { ascending: false }).limit(500);
    setImported((i ?? []) as Example[]);
    const { data: s } = await sb.from("settings").select("value").eq("key", "website_sync").maybeSingle();
    setSync((s?.value as SyncStatus | undefined) ?? null);
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

  async function syncNow(force = false) {
    setSyncing(true);
    await fetch("/api/knowledge/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }) });
    setSyncing(false);
    load();
  }

  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
  const categories = [...new Set(items.map((i) => i.category))];
  const kb = items.filter((i) => match(`${i.category} ${i.title} ${i.content}`));
  const ex = (onlyImported ? imported : examples).filter((x) => (showHidden || x.active) && match(`${x.question} ${x.answer}`));
  const batchIds = [...new Set(imported.filter((x) => x.active && x.import_batch_id).map((x) => x.import_batch_id as string))];

  async function hideBatches() {
    if (!confirmHide) return setConfirmHide(true);
    setConfirmHide(false);
    for (const id of batchIds) {
      await fetch("/api/imports/line", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, hidden: true }) });
    }
    load();
  }

  return (
    <div className={embedded ? "" : "page"}>
      {!embedded && <h1>ฐานข้อมูล &amp; คำตอบที่เรียนรู้</h1>}
      {!embedded && <p className="muted">AI ใช้ฐานข้อมูลคลินิกเป็นแหล่งหลัก (ข้อมูลล่าสุดเสมอ) และใช้คำตอบเดิมของเจ้าหน้าที่เป็นแบบอย่างสำนวน</p>}

      <div className="tabs wide">
        <button className={tab === "kb" ? "on" : ""} onClick={() => setTab("kb")}>📚 ฐานข้อมูลคลินิก ({items.length})</button>
        <button className={tab === "ex" ? "on" : ""} onClick={() => setTab("ex")}>💬 คำตอบที่เรียนรู้ ({examples.filter((x) => x.active).length})</button>
        <button className={tab === "media" ? "on" : ""} onClick={() => setTab("media")}>📷 รูปที่ใช้บ่อย</button>
        <button className={tab === "lab" ? "on" : ""} onClick={() => setTab("lab")}>🧪 ราคาแล็บ</button>
        <input className="search" placeholder="ค้นหา…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {tab === "kb" && (
        <div className="card row between">
          <div className="small">
            {sync?.last_success_at ? <>ซิงก์จากเว็บล่าสุด {timeTh(sync.last_success_at)} ({sync.count ?? 0} บริการ, {sync.pages ?? 0} หัวข้อจากหน้าเว็บและบทความ)</> : "ยังไม่เคยซิงก์ราคาจากเว็บ"}
            {sync?.error && <div className="chip red">{sync.error}</div>}
            {sync?.pages_error && <div className="chip red">หน้าเว็บ: {sync.pages_error}</div>}
          </div>
          <div className="row">
            {sync?.needs_confirm && <button className="btn ghost small" disabled={syncing} onClick={() => syncNow(true)}>ยืนยันปิดบริการที่หายจากเว็บ</button>}
            <button className="btn ghost small" disabled={syncing} onClick={() => syncNow()}>{syncing ? "กำลังซิงก์…" : "ซิงก์จากเว็บตอนนี้"}</button>
          </div>
        </div>
      )}

      {tab === "lab" ? <LabPricesPanel /> : tab === "media" ? <QuickMediaPanel /> : tab === "kb" ? (
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
                  <div>
                    <span className="chip">{i.category}</span> <b>{i.title}</b>
                    {i.category === GUIDE_CATEGORY && <> <span className="chip red">ต้องให้แพทย์ตรวจทาน</span> <span className="chip">{i.review_status === "approved" ? "✅ แพทย์อนุมัติแล้ว" : "ร่าง AI ยังไม่ใช้"}</span></>}
                  </div>
                  {i.source === "website" || i.source === "website_page" ? <span className="chip">จากเว็บ — แก้ที่หลังบ้านเว็บ</span> : (
                    <div className="row">
                      {i.category === GUIDE_CATEGORY && i.review_status !== "approved" && (
                        <button className="btn ghost small" onClick={async () => {
                          const res = await fetch("/api/knowledge/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: i.id }) });
                          setMsg(res.ok ? "บันทึกว่าแพทย์อนุมัติแล้ว AI จะใช้แนวทางนี้" : "บันทึกไม่สำเร็จ");
                          load();
                        }}>แพทย์อนุมัติแล้ว</button>
                      )}
                      <button className="btn ghost small" onClick={() => setForm({ id: i.id, category: i.category, title: i.title, content: i.content })}>แก้ไข</button>
                      <button className="btn ghost small" onClick={async () => {
                        await sb.from("knowledge_items").update({ active: !i.active }).eq("id", i.id); load();
                      }}>{i.active ? "ปิดใช้" : "เปิดใช้"}</button>
                    </div>
                  )}
                </div>
                <div className="pre">{i.content}</div>
                <div className="muted small">อัปเดต {dateTh(i.updated_at)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <div className="row between">
            <div className="row">
              <label className="raw"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> แสดงที่ซ่อนแล้ว</label>
              <label className="raw"><input type="checkbox" checked={onlyImported} onChange={(e) => { setOnlyImported(e.target.checked); setConfirmHide(false); }} /> นำเข้าจาก LINE ({imported.filter((x) => x.active).length})</label>
              {onlyImported && batchIds.length > 0 && (
                <button className="btn ghost small" onClick={hideBatches}>{confirmHide ? "ยืนยันซ่อนทั้งชุด?" : "ซ่อนทั้งชุดการนำเข้า"}</button>
              )}
            </div>
            <div className="row">
              <span className="muted small">
                พร้อมใช้เทรน: {examples.filter((x) => x.active && (x.starred || x.use_count >= 2)).length} คู่ (ติดดาว หรือถูกใช้ ≥ 2 ครั้ง)
              </span>
              <a className="btn ghost small" href="/api/examples/export?min_use=2" download>⬇ ส่งออกข้อมูลสำหรับเทรน (.jsonl)</a>
            </div>
          </div>
          {ex.length === 0 && <div className="empty">ยังไม่มีคำตอบที่เรียนรู้ — ระบบจะเก็บอัตโนมัติทุกครั้งที่เจ้าหน้าที่ตอบ</div>}
          {ex.map((x) => (
            <ExampleRow key={x.id} x={x} onChange={load} />
          ))}
        </div>
      )}
    </div>
  );
}

interface QuickItem { id: string; title: string; preview_path: string; url?: string }

function QuickMediaPanel() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [items, setItems] = useState<QuickItem[]>([]);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const { data } = await sb.from("quick_media").select("id, title, preview_path").order("created_at", { ascending: false });
    const rows = (data ?? []) as QuickItem[];
    const { data: urls } = rows.length
      ? await sb.storage.from("quick-media").createSignedUrls(rows.map((r) => r.preview_path), 3600)
      : { data: [] };
    setItems(rows.map((r, i) => ({ ...r, url: urls?.[i]?.signedUrl ?? undefined })));
  }, [sb]);
  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setMsg("กรุณาเลือกรูป");
    if (file.size > MAX_UPLOAD_BYTES) return setMsg("รูปต้องไม่เกิน 10MB");
    setBusy(true);
    setMsg("");
    try {
      const uploadPath = await uploadStaffImage(file);
      const res = await fetch("/api/quick-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadPath, title }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "บันทึกไม่สำเร็จ");
      setTitle(""); setFile(null);
      (e.target as HTMLFormElement).reset();
      load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form className="card form" onSubmit={add}>
        <h3>เพิ่มรูปที่ใช้บ่อย</h3>
        <label>ชื่อรูป<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น แผนที่คลินิก" required /></label>
        <label>ไฟล์รูป (JPEG, PNG, WebP, HEIC ไม่เกิน 10MB)
          <input type="file" accept="image/*,.heic,.heif" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </label>
        {msg && <div className="muted small">{msg}</div>}
        <div className="row"><button className="btn primary" disabled={busy}>{busy ? "กำลังบันทึก…" : "เพิ่มรูป"}</button></div>
      </form>
      {items.length === 0 && <div className="empty">ยังไม่มีรูปที่ใช้บ่อย</div>}
      <div className="quick-grid">
        {items.map((i) => (
          <div key={i.id} className="card quick-card">
            {i.url && <img src={i.url} alt={i.title} />}
            <b>{i.title}</b>
            <button className="btn ghost small" onClick={async () => {
              await fetch(`/api/quick-media?id=${i.id}`, { method: "DELETE" });
              load();
            }}>ลบ</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExampleRow({ x, onChange }:{ x: Example; onChange: () => void }) {
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
