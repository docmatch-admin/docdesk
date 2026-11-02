"use client";

import { useMemo, useState } from "react";
import { buildPastePairs, maskPastedShape, MAX_PASTE_PAIRS, parsePastedChat, type PasteLine, type PasteSender } from "@/lib/paste-import";

interface Draft { question: string; answer: string; selected: boolean; starred: boolean }

const SENDERS: { value: PasteSender; label: string }[] = [
  { value: "customer", label: "ลูกค้า" },
  { value: "clinic", label: "คลินิก" },
  { value: "skip", label: "ข้าม" },
];

/** ข้อความที่วางอยู่ในหน้านี้เท่านั้น ส่งออกไปเฉพาะคู่ที่เลือกตอนกดบันทึก */
export function PasteClient() {
  const [raw, setRaw] = useState("");
  const [lines, setLines] = useState<PasteLine[]>([]);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const unknown = useMemo(() => lines.filter((l) => l.sender === "unknown").length, [lines]);
  const chosen = drafts?.filter((d) => d.selected) ?? [];

  function split() {
    setLines(parsePastedChat(raw));
    setDrafts(null);
    setMsg("");
  }

  function setSender(i: number, sender: PasteSender) {
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, sender } : l)));
    setDrafts(null);
  }

  function preview() {
    setDrafts(buildPastePairs(lines).map((p) => ({ ...p, selected: true, starred: false })));
  }

  const patch = (i: number, next: Partial<Draft>) =>
    setDrafts((prev) => prev?.map((d, j) => (j === i ? { ...d, ...next } : d)) ?? null);

  async function copyShape() {
    try {
      await navigator.clipboard.writeText(maskPastedShape(raw));
      setMsg("คัดลอกโครงสร้างแล้ว ไม่มีเนื้อหาข้อความ");
    } catch {
      setMsg("คัดลอกไม่สำเร็จ");
    }
  }

  async function save() {
    if (chosen.length > MAX_PASTE_PAIRS) return setMsg(`บันทึกได้ครั้งละไม่เกิน ${MAX_PASTE_PAIRS} คู่`);
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/imports/paste", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairs: chosen.map(({ question, answer, starred }) => ({ question, answer, starred })) }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setMsg(j.error ?? "บันทึกไม่สำเร็จ");
    setMsg(`บันทึกแล้ว ${j.saved} คู่ · ซ้ำของเดิม ${j.duplicates} คู่${j.invalid ? ` · สั้นเกินไป ${j.invalid} คู่` : ""}${j.sensitive ? ` · ข้ามเรื่องลับ ${j.sensitive} คู่` : ""}`);
    setRaw("");
    setLines([]);
    setDrafts(null);
  }

  return (
    <div className="page narrow">
      <h1>นำเข้าคำตอบแบบวางข้อความ</h1>
      <p className="muted small">เปิดห้องแชทใน chat.line.biz กด Ctrl+A, Ctrl+C แล้ววางทีละห้อง ระบบเก็บเฉพาะคู่ที่คุณเลือก ไม่เก็บข้อความที่วาง ไม่จับคู่กับลูกค้า และไม่สร้างประวัติแชท</p>

      <section className="card form">
        <label>ข้อความจากห้องแชท
          <textarea rows={12} value={raw} onChange={(e) => setRaw(e.target.value)} />
        </label>
        <div className="row">
          <button className="btn primary" disabled={!raw.trim()} onClick={split}>แยกบรรทัด</button>
          <button className="btn ghost" disabled={!raw.trim()} onClick={copyShape}>คัดลอกโครงสร้าง (ไม่มีเนื้อหา)</button>
        </div>
        {msg && <div className="small" role="status">{msg}</div>}
      </section>

      {lines.length > 0 && (
        <section className="card">
          <h3>ผู้ส่งแต่ละบรรทัด {unknown > 0 && <span className="muted small">ยังไม่ระบุ {unknown} บรรทัด</span>}</h3>
          <div className="paste-lines">
            {lines.map((l, i) => (
              <div key={i} className={`paste-line s-${l.sender}`}>
                <span className="grow">{l.text}</span>
                <div className="paste-senders" role="group" aria-label={`ผู้ส่งบรรทัดที่ ${i + 1}`}>
                  {SENDERS.map((s) => (
                    <button key={s.value} className={l.sender === s.value ? "on" : ""} aria-pressed={l.sender === s.value} onClick={() => setSender(i, s.value)}>{s.label}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="row">
            <button className="btn primary" onClick={preview}>ดูคู่คำถาม-คำตอบ</button>
            {unknown > 0 && <span className="muted small">บรรทัดที่ยังไม่ระบุจะตัดคู่ ไม่ถูกบันทึก</span>}
          </div>
        </section>
      )}

      {drafts && (
        <section className="card">
          <div className="row between">
            <h3>คู่ที่จะบันทึก ({chosen.length}/{drafts.length})</h3>
            <button className="btn ghost small" onClick={() => setDrafts(drafts.map((d) => ({ ...d, starred: true })))}>⭐ ติดดาวทั้งหมด</button>
          </div>
          {drafts.length === 0 && <div className="muted small">ไม่พบคู่คำถาม-คำตอบ ตรวจผู้ส่งแต่ละบรรทัด</div>}
          {drafts.map((d, i) => (
            <div key={i} className={`paste-pair ${d.selected ? "" : "off"}`}>
              <label className="raw"><input type="checkbox" checked={d.selected} onChange={(e) => patch(i, { selected: e.target.checked })} /> ถาม: {d.question}</label>
              <textarea rows={2} aria-label={`คำตอบคู่ที่ ${i + 1}`} value={d.answer} onChange={(e) => patch(i, { answer: e.target.value })} />
              <label className="raw"><input type="checkbox" checked={d.starred} onChange={(e) => patch(i, { starred: e.target.checked })} /> ⭐ คำตอบมาตรฐาน</label>
            </div>
          ))}
          {drafts.length > 0 && (
            <>
              <p className="muted small">ระบบลบเบอร์ อีเมล เลขบัตร และ HN ให้แล้ว แต่ชื่อลูกค้าในข้อความลบเองไม่ได้ โปรดตรวจก่อนบันทึก คำตอบติดดาวอาจถูกแนะนำโดยไม่ผ่าน AI จึงควรตรวจราคาให้เป็นปัจจุบัน</p>
              <button className="btn primary" disabled={busy || !chosen.length} onClick={save}>{busy ? "กำลังบันทึก…" : `บันทึก ${chosen.length} คู่`}</button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
