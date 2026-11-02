"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ambiguousNames, buildExamplePairs, findMassMessages, groupRooms, parseLineHistory, summarizeImport, type ImportMeta, type ImportRoom, type ImportSummary,
} from "@/lib/line-import";
import { matchSensitive } from "@/lib/sensitive-rules";

interface Batch { id: string; filename: string | null; rooms: number; messages_imported: number; examples_imported: number; hidden_at: string | null; created_at: string }
interface MergeLog { id: number; action: string; messages: number; created_at: string; staff: { display_name: string } | null; conversations: { contacts: { display_name: string | null } | null } | null }
const LOG_ACTION: Record<string, string> = { merge: "รวมประวัติ", dismiss: "ไม่ใช่คนเดียวกัน", split: "แยกประวัติ" };

interface Preview {
  filename: string;
  rooms: ImportRoom[];
  summary: ImportSummary;
  invalid: number;
  matched: Set<string>;
  ambiguous: Set<string>;
  meta: ImportMeta | null;
  duplicates: number;
  overlap: number;
  estimatedTimes: number;
  sensitiveRooms: number;
  pairs: number;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const dateTh = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit", timeZone: "Asia/Bangkok" }) : "–");

export function ImportsClient() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [logs, setLogs] = useState<MergeLog[]>([]);
  const [msg, setMsg] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const loadBatches = useCallback(async () => {
    const res = await fetch("/api/imports/line");
    if (!res.ok) return;
    const j = (await res.json()) as { batches: Batch[]; logs: MergeLog[] };
    setBatches(j.batches);
    setLogs(j.logs);
  }, []);
  useEffect(() => { loadBatches(); }, [loadBatches]);

  async function chooseFile(file: File | undefined) {
    setPreview(null);
    setMsg("");
    if (!file) return;
    if (file.name.toLowerCase().endsWith(".zip")) {
      return setMsg("ยังอ่านไฟล์ zip สำรองของ LINE ไม่ได้ ต้องเห็นรูปแบบไฟล์จริงก่อน ตอนนี้รับเฉพาะ .jsonl");
    }
    const { records, invalid, meta, duplicates, estimatedTimes } = parseLineHistory(await file.text());
    if (!records.length) return setMsg(`ไม่พบข้อความที่อ่านได้ในไฟล์นี้ (แถวเสีย ${invalid})`);
    const rooms = groupRooms(records);
    const ambiguous = ambiguousNames(rooms);
    const names = [...new Set(rooms.map((r) => r.room).filter((n) => !ambiguous.has(n)))];
    const res = await fetch("/api/imports/line/preview", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({
      names,
      rooms: rooms.filter((r) => !ambiguous.has(r.room)).map((r) => ({ name: r.room, times: r.messages.map((m) => m.sent_at) })),
    }) });
    if (!res.ok) return setMsg("ตรวจรายชื่อลูกค้าไม่สำเร็จ");
    const { matched, overlap, keywords } = (await res.json()) as { matched: string[]; overlap: number; keywords: string[] };
    const isSensitive = (r: ImportRoom) => r.messages.some((m) => matchSensitive(m.text, keywords));
    const mass = findMassMessages(rooms);
    setPreview({
      filename: file.name, rooms, summary: summarizeImport(rooms), invalid, matched: new Set(matched), ambiguous,
      meta, duplicates, overlap, estimatedTimes,
      sensitiveRooms: rooms.filter(isSensitive).length,
      pairs: rooms.filter((r) => !isSensitive(r)).reduce((n, r) => n + buildExamplePairs(r, mass).length, 0),
    });
  }

  async function runImport() {
    if (!preview) return;
    setMsg("");
    const start = await fetch("/api/imports/line", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ filename: preview.filename }) });
    if (!start.ok) return setMsg("เริ่มนำเข้าไม่สำเร็จ");
    const { id } = (await start.json()) as { id: string };
    const mass = [...findMassMessages(preview.rooms)];
    let messages = 0, examples = 0, failed = 0, archived = 0;
    setProgress({ done: 0, total: preview.rooms.length });
    for (const [i, room] of preview.rooms.entries()) {
      const res = await fetch("/api/imports/line/room", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          batchId: id, key: room.key, room: room.room, messages: room.messages, chatId: room.chatId, archiveUnmatched: true,
          mass: mass.filter((t) => room.messages.some((m) => m.text.trim() === t)),
          historyAllowed: !preview.ambiguous.has(room.room) && preview.matched.has(room.room),
        }),
      });
      if (res.ok) {
        const r = (await res.json()) as { messages: number; examples: number; archived: boolean };
        if (r.archived) archived++;
        messages += r.messages;
        examples += r.examples;
      } else failed++;
      setProgress({ done: i + 1, total: preview.rooms.length });
    }
    setProgress(null);
    setPreview(null);
    setMsg(`นำเข้าแล้ว ประวัติแชท ${messages} ข้อความ แชทเก่าใหม่ ${archived} ห้อง คำตอบที่เรียนรู้ ${examples} คู่${failed ? ` · ไม่สำเร็จ ${failed} ห้อง กดนำเข้าไฟล์เดิมซ้ำได้` : ""}`);
    loadBatches();
  }

  async function toggleHidden(b: Batch) {
    const res = await fetch("/api/imports/line", { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ id: b.id, hidden: !b.hidden_at }) });
    if (!res.ok) setMsg("บันทึกไม่สำเร็จ");
    loadBatches();
  }

  const s = preview?.summary;
  const matchedRooms = preview ? preview.rooms.filter((r) => preview.matched.has(r.room) && !preview.ambiguous.has(r.room)).length : 0;

  return (
    <div className="page narrow">
      <h1>นำเข้าประวัติ LINE</h1>
      <p className="muted small">ข้อความที่นำเข้าเป็นประวัติเท่านั้น ไม่เข้ารอตอบ ไม่มีเสียงเตือน ไม่คิดคะแนน และ AI ไม่ใช้ตัวเลขจากคำตอบที่นำเข้าเป็นแหล่งยืนยัน</p>

      <section className="card form">
        <label>ไฟล์ประวัติ (.jsonl)
          <input type="file" accept=".jsonl,.zip" disabled={!!progress} onChange={(e) => chooseFile(e.target.files?.[0])} />
        </label>
        {msg && <div className="small" role="status">{msg}</div>}
      </section>

      {preview && s && (
        <section className="card import-summary">
          <h3>สรุปก่อนยืนยัน</h3>
          <dl>
            <dt>ห้อง</dt><dd>{s.rooms}</dd>
            <dt>ข้อความ</dt><dd>{s.messages}{preview.invalid > 0 && ` (แถวเสีย ${preview.invalid} แถว ไม่นำเข้า)`}</dd>
            {preview.meta && <><dt>ตามไฟล์</dt><dd>{preview.meta.rooms} ห้อง {preview.meta.messages} แถว (รวมข้อความระบบ){preview.meta.list_complete === false && " · ไล่รายการไม่ครบ"}{(preview.meta.errors?.length ?? 0) > 0 && ` · ข้อผิดพลาด ${preview.meta.errors?.length}`}</dd></>}
            <dt>ช่วงวันที่</dt><dd>{dateTh(s.from)} – {dateTh(s.to)}</dd>
            <dt>ลูกค้าเดิม (จับคู่ชื่อได้)</dt><dd>{matchedRooms} คน</dd>
            <dt>จับคู่ไม่ได้ (เก็บเป็นแชทเก่า)</dt><dd>{s.rooms - matchedRooms} ห้อง{preview.ambiguous.size > 0 && ` รวมชื่อซ้ำ ${preview.ambiguous.size} ชื่อ`}</dd>
            <dt>แชทลับ</dt><dd>{preview.sensitiveRooms} ห้อง (ไม่สร้างคู่คำตอบ)</dd>
            <dt>คู่คำถาม-คำตอบ</dt><dd>{preview.pairs} คู่</dd>
            <dt>ข้อความซ้ำที่ข้าม</dt><dd>{preview.duplicates} แถวในไฟล์ · {preview.overlap} ข้อความที่มีในระบบแล้ว</dd>
            {preview.estimatedTimes > 0 && <><dt>เวลาโดยประมาณ</dt><dd>{preview.estimatedTimes} ข้อความไม่มีเวลาในไฟล์</dd></>}
          </dl>
          <p className="muted small">ประวัตินำเข้าเฉพาะข้อความเก่ากว่าข้อความแรกในระบบของลูกค้าคนนั้น นำเข้าซ้ำได้ แถวที่มีแล้วจะถูกข้าม</p>
          <div className="row">
            <button className="btn primary" disabled={!!progress} onClick={runImport}>
              {progress ? `กำลังนำเข้า ${progress.done}/${progress.total}…` : "ยืนยันนำเข้า"}
            </button>
            <button className="btn ghost" disabled={!!progress} onClick={() => setPreview(null)}>ยกเลิก</button>
          </div>
        </section>
      )}

      <section className="card">
        <h3>ชุดที่นำเข้าแล้ว</h3>
        {batches.length === 0 && <div className="muted small">ยังไม่มี</div>}
        {batches.map((b) => (
          <div key={b.id} className={`tag-row ${b.hidden_at ? "off" : ""}`}>
            <span className="grow small">
              {dateTh(b.created_at)} · {b.rooms} ห้อง · {b.messages_imported} ข้อความ · {b.examples_imported} คู่{b.hidden_at ? " · ซ่อนคำตอบแล้ว" : ""}
            </span>
            <button className="btn ghost small" onClick={() => toggleHidden(b)}>{b.hidden_at ? "แสดงคำตอบทั้งชุด" : "ซ่อนคำตอบทั้งชุด"}</button>
          </div>
        ))}
      </section>

      <section className="card">
        <h3>ประวัติการรวมและแยก</h3>
        {logs.length === 0 && <div className="muted small">ยังไม่มี</div>}
        {logs.map((l) => (
          <div key={l.id} className="small">
            {dateTh(l.created_at)} · {LOG_ACTION[l.action] ?? l.action} · {l.conversations?.contacts?.display_name || "–"}{l.messages > 0 && ` · ${l.messages} ข้อความ`} · โดย {l.staff?.display_name ?? "–"}
          </div>
        ))}
      </section>
    </div>
  );
}
