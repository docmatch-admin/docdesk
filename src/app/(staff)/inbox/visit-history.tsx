"use client";

import { useEffect, useState } from "react";
import { thaiShortDate } from "@/lib/appointment-rules";
import type { VisitHistory } from "@/lib/visit-history";

/** โหลดประวัติการมาตรวจของคนไข้หลักของแชท (โหลดใหม่เมื่อเปลี่ยนแชท/ผูก HN ใหม่) */
export function useVisitHistory(conversationId: string | null, hn: string | null | undefined) {
  const [data, setData] = useState<VisitHistory | null>(null);
  useEffect(() => {
    setData(null);
    if (!conversationId || !hn) return;
    let alive = true;
    fetch(`/api/conversations/${conversationId}/visits`).then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j) setData(j as VisitHistory); }).catch(() => {});
    return () => { alive = false; };
  }, [conversationId, hn]);
  return data;
}

/** สิทธิ/อายุ ล่าสุดที่มีค่า (ไม่มี = ไม่แสดง) */
export function latestFacts(h: VisitHistory | null) {
  const v = h?.visits ?? [];
  return { rights: v.find((x) => x.rights)?.rights ?? null, age: v.find((x) => x.age != null)?.age ?? null };
}

/** "ประวัติที่คลินิก · มา N ครั้ง": ครั้งล่าสุด 1 ครั้ง กด "ดูทั้งหมด" ขยาย · ไม่มีประวัติ = ไม่แสดงกล่อง */
export function VisitHistoryBlock({ history, blurred }: { history: VisitHistory | null; blurred: boolean }) {
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [history?.hn]);
  if (!history || !history.visits.length) return null;
  const shown = all ? history.visits : history.visits.slice(0, 1);
  return (
    <section className={`side-block visit-history ${blurred ? "sensitive-blur" : ""}`}>
      <div className="visit-head">
        <h3>ประวัติที่คลินิก · มา {history.total} ครั้ง</h3>
        {history.visits.length > 1 && (
          <button type="button" className="link-btn" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "ย่อ" : `ดูทั้งหมด (${history.total} ครั้ง)`}</button>
        )}
      </div>
      <ul className="visit-list">
        {shown.map((v) => (
          <li key={v.vn}>
            <div className="visit-row"><b>{thaiShortDate(v.date)}</b>{v.doctor && <span className="muted">{v.doctor}</span>}</div>
            {v.diagnosis && <div className="one">{v.diagnosis}</div>}
          </li>
        ))}
      </ul>
      {all && history.total > history.visits.length && <div className="muted small">แสดง {history.visits.length} ครั้งล่าสุด (เก็บย้อนหลัง 1 ปี)</div>}
    </section>
  );
}
