"use client";

import { useEffect, useState } from "react";

interface Candidate { id: string; messages: number; from: string | null; to: string | null; sensitive: boolean }

const dateTh = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit", timeZone: "Asia/Bangkok" }) : "–");
const describe = (c: Candidate) => `${c.messages} ข้อความ · ${dateTh(c.from)} – ${dateTh(c.to)}${c.sensitive ? " · 🔒 ลับ" : ""}`;

/** ถามก่อนรวมเสมอ ระบบไม่รวมเอง เพราะชื่อตรงกันอาจเป็นคนละคน */
export function ArchiveMergeBar({ conversationId, onDone, onError }: {
  conversationId: string;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stale = false;
    setCandidates([]);
    setPicked("");
    fetch(`/api/conversations/${conversationId}/archive`).then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (stale || !j) return;
      setCandidates(j.candidates);
      if (j.candidates.length === 1) setPicked(j.candidates[0].id);
    });
    return () => { stale = true; };
  }, [conversationId]);

  async function act(action: "merge" | "dismiss", archivedId: string) {
    const res = await fetch(`/api/conversations/${conversationId}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, archivedId }),
    });
    if (!res.ok) onError((await res.json().catch(() => ({}))).error ?? "ทำรายการไม่สำเร็จ");
    return res.ok;
  }

  async function merge() {
    setBusy(true);
    if (await act("merge", picked)) {
      setCandidates([]);
      onDone();
    }
    setBusy(false);
  }

  async function dismiss() {
    setBusy(true);
    // เลือกไว้แห่งเดียวปฏิเสธแห่งนั้น ไม่ได้เลือกปฏิเสธทั้งหมด
    const targets = picked && candidates.length > 1 ? [picked] : candidates.map((c) => c.id);
    for (const id of targets) await act("dismiss", id);
    setCandidates((prev) => prev.filter((c) => !targets.includes(c.id)));
    setPicked("");
    setBusy(false);
  }

  if (!candidates.length) return null;
  return (
    <div className="archive-bar" role="region" aria-label="ประวัติเก่าจาก LINE OA">
      <b>พบประวัติเก่าจาก LINE OA ชื่อเดียวกัน — รวมประวัติ?</b>
      {candidates.length === 1 ? (
        <span className="small muted">{describe(candidates[0])}</span>
      ) : (
        <div className="archive-options">
          {candidates.map((c) => (
            <label key={c.id} className="raw small">
              <input type="radio" name="archive-candidate" checked={picked === c.id} onChange={() => setPicked(c.id)} /> {describe(c)}
            </label>
          ))}
        </div>
      )}
      <div className="row">
        <button className="btn primary small" disabled={busy || !picked} onClick={merge}>รวม</button>
        <button className="btn ghost small" disabled={busy} onClick={dismiss}>ไม่ใช่คนเดียวกัน</button>
      </div>
    </div>
  );
}
