"use client";

import { useEffect, useState } from "react";
import type { TeamPeriod, TeamRow } from "@/lib/scoring";

const PERIODS: [TeamPeriod, string][] = [["day", "วันนี้"], ["week", "สัปดาห์นี้"], ["month", "เดือนนี้"]];

function formatSeconds(s: number | null): string {
  if (s === null) return "–";
  if (s < 60) return `${Math.round(s)} วินาที`;
  if (s < 3600) return `${Math.round(s / 60)} นาที`;
  return `${(s / 3600).toFixed(1)} ชม.`;
}

export function TeamReport({ meId, isAdmin }: { meId: string; isAdmin: boolean }) {
  const [period, setPeriod] = useState<TeamPeriod>("day");
  const [rows, setRows] = useState<TeamRow[]>([]);
  const [ranking, setRanking] = useState<{ staffId: string; name: string; total: number; rank: number }[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    fetch(`/api/reports/team?period=${period}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((j) => {
        if (stale) return;
        setRows(j.rows);
        setRanking(j.ranking);
        setError("");
      })
      .catch(() => { if (!stale) setError("โหลดรายงานไม่สำเร็จ"); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [period]);

  return (
    <div className="report-grid">
      <div className="tabs wide" role="group" aria-label="ช่วงเวลา">
        {PERIODS.map(([p, label]) => (
          <button key={p} className={period === p ? "on" : ""} aria-pressed={period === p} onClick={() => setPeriod(p)}>{label}</button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}

      <section className="card">
        <h3>{isAdmin ? "ผลงานทีม" : "ผลงานของฉัน"}</h3>
        <p className="muted small">เวลาตอบนับเฉพาะเวลาทำการ ไม่นับคำขอบคุณ สติกเกอร์ และชุดข้อความที่ AI ตอบไปแล้ว</p>
        <div className="report-table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th scope="col">เจ้าหน้าที่</th>
                <th scope="col">แชทที่ตอบ</th>
                <th scope="col">เวลาตอบ (median)</th>
                <th scope="col">ตอบใน 5 นาที</th>
                <th scope="col">คะแนนความเร็ว</th>
                <th scope="col">คะแนนคุณภาพ</th>
                <th scope="col">รวม</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.staffId}>
                  <td>{r.name}{r.staffId === meId ? " (คุณ)" : ""}</td>
                  <td>{r.chats}</td>
                  <td>{formatSeconds(r.medianSeconds)}</td>
                  <td>{r.within5Percent === null ? "–" : `${r.within5Percent}%`}</td>
                  <td>{r.speedPoints}</td>
                  <td>{r.qualityPoints}</td>
                  <td><b>{r.total}</b></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="muted">{loading ? "กำลังโหลด…" : "ยังไม่มีข้อมูลในช่วงนี้"}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {!isAdmin && (
        <section className="card">
          <h3>อันดับทีม</h3>
          {ranking.map((r) => (
            <div key={r.staffId} className="row between ch-row">
              <span>{r.rank}. {r.name}{r.staffId === meId ? " (คุณ)" : ""}</span>
              <b>{r.total}</b>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
