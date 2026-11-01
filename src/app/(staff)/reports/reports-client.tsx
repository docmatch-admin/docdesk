"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import {
  bangkokDay, bangkokRange, buildBuckets, buildReportTable, niceMax,
  type ReportRow, type ReportUnit,
} from "@/lib/tags";

const DAY = 86_400_000;
const shiftDays = (days: number) => bangkokDay(new Date(Date.now() - days * DAY));
const defaultRange = (unit: ReportUnit) => ({ from: unit === "day" ? shiftDays(29) : `${shiftDays(335).slice(0, 7)}-01`, to: shiftDays(0) });

const bucketLabel = (bucket: string, unit: ReportUnit) =>
  new Date(`${bucket}T00:00:00Z`).toLocaleDateString("th-TH", unit === "day"
    ? { day: "numeric", month: "short", timeZone: "UTC" }
    : { month: "short", year: "2-digit", timeZone: "UTC" });

export function ReportsClient() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [unit, setUnit] = useState<ReportUnit>("day");
  const [{ from, to }, setRange] = useState(() => defaultRange("day"));
  const [data, setData] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to || from > to) return;
    let stale = false;
    const range = bangkokRange(from, to);
    sb.rpc("tag_report", { p_unit: unit, p_from: range.from, p_to: range.to }).then(({ data: rows, error: e }) => {
      if (stale) return;
      setError(e ? "โหลดรายงานไม่สำเร็จ" : "");
      setData((rows ?? []) as ReportRow[]);
      setLoading(false);
    });
    return () => { stale = true; };
  }, [sb, unit, from, to]);

  const table = useMemo(() => buildReportTable(data, buildBuckets(unit, from, to)), [data, unit, from, to]);
  const selected = table.rows.find((r) => r.tag === picked) ?? table.rows[0] ?? null;
  const maxTotal = Math.max(1, ...table.rows.map((r) => r.total));
  const exportUrl = `/api/reports/export?from=${from}&to=${to}${picked ? `&tag=${encodeURIComponent(picked)}` : ""}`;

  function changeUnit(next: ReportUnit) {
    setUnit(next);
    setRange(defaultRange(next));
  }

  return (
    <div className="page">
      <h1>รายงานแท็ก</h1>
      <p className="muted">จำนวนแชทที่ถูกติดแท็กในแต่ละช่วงเวลา ตามเวลาไทย ไม่นับแท็กที่เจ้าหน้าที่เอาออกเอง ลูกค้าเดิมที่กลับมาเรื่องใหม่นับด้วย</p>

      <div className="report-filters">
        <div className="tabs wide" role="group" aria-label="หน่วยเวลา">
          <button className={unit === "day" ? "on" : ""} onClick={() => changeUnit("day")}>รายวัน</button>
          <button className={unit === "month" ? "on" : ""} onClick={() => changeUnit("month")}>รายเดือน</button>
        </div>
        <label>ตั้งแต่<input type="date" value={from} max={to} onChange={(e) => setRange({ from: e.target.value, to })} /></label>
        <label>ถึง<input type="date" value={to} min={from} onChange={(e) => setRange({ from, to: e.target.value })} /></label>
        <label>แท็กที่ส่งออก
          <select value={picked ?? ""} onChange={(e) => setPicked(e.target.value || null)}>
            <option value="">ทุกแท็ก</option>
            {table.rows.map((r) => <option key={r.tag} value={r.tag}>{r.tag}</option>)}
          </select>
        </label>
        <a className="btn ghost" href={exportUrl} download>⬇ ส่งออก CSV</a>
      </div>

      {error && <div className="error">{error}</div>}
      {!loading && !error && table.rows.length === 0 && (
        <div className="card empty">ยังไม่มีแชทที่ถูกติดแท็กในช่วงนี้</div>
      )}

      {table.rows.length > 0 && (
        <div className="report-grid">
          <section className="card">
            <h3>แชทรวมตามแท็ก</h3>
            <p className="muted small">กดแท็กเพื่อดูกราฟรายช่วงเวลาด้านล่าง</p>
            {table.rows.map((r) => (
              <button key={r.tag} className={`hbar-row ${selected?.tag === r.tag ? "on" : ""}`}
                aria-pressed={selected?.tag === r.tag} onClick={() => setPicked(r.tag)}>
                <span className="hbar-label" title={r.tag}>{r.tag}</span>
                <span className="hbar-track">
                  <span className="hbar" style={{ width: `${(r.total / maxTotal) * 85}%` }} />
                  {r.total.toLocaleString("th-TH")}
                </span>
              </button>
            ))}
          </section>

          {selected && (
            <section className="card">
              <h3>{selected.tag}: แชท{unit === "day" ? "รายวัน" : "รายเดือน"}</h3>
              <ColumnChart buckets={table.buckets} counts={selected.counts} unit={unit} tag={selected.tag} />
            </section>
          )}

          <section className="card">
            <h3>ตาราง</h3>
            <div className="report-table-wrap">
              <table className="report-table">
                <thead>
                  <tr>
                    <th scope="col">แท็ก</th>
                    {table.buckets.map((b) => <th key={b} scope="col">{bucketLabel(b, unit)}</th>)}
                    <th scope="col">รวม</th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((r) => (
                    <tr key={r.tag}>
                      <td>{r.tag}</td>
                      {r.counts.map((c, i) => <td key={table.buckets[i]} className={c ? "" : "zero"}>{c}</td>)}
                      <td><b>{r.total}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/** แท็กหนึ่งแท็ก สีเดียว จึงไม่ต้องมี legend ค่าทุกแท่งดูได้จาก hover/focus และตาราง */
function ColumnChart({ buckets, counts, unit, tag }: { buckets: string[]; counts: number[]; unit: ReportUnit; tag: string }) {
  const [active, setActive] = useState<number | null>(null);
  const top = niceMax(Math.max(...counts, 0));
  const every = Math.max(1, Math.ceil(buckets.length / 8));
  const ticks = top > 1 ? [top, top / 2] : [top];

  return (
    <div className="columns-chart">
      <div className="columns-plot" role="img" aria-label={`กราฟแท่งจำนวนแชทแท็ก ${tag} ตัวเลขทั้งหมดอยู่ในตารางด้านล่าง`}>
        {ticks.map((t) => (
          <div key={t} className="grid-line" style={{ bottom: `${(t / top) * 100}%` }}>
            <span>{Number.isInteger(t) ? t : ""}</span>
          </div>
        ))}
        {buckets.map((b, i) => (
          <button key={b} className="column-slot" tabIndex={0}
            aria-label={`${bucketLabel(b, unit)}: ${counts[i]} แชท`}
            onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(i)} onBlur={() => setActive(null)}>
            {counts[i] > 0 && <span className="column" style={{ height: `${(counts[i] / top) * 100}%` }} />}
            {active === i && <span className="chart-tip"><b>{counts[i]}</b> แชท · {bucketLabel(b, unit)}</span>}
          </button>
        ))}
      </div>
      <div className="column-axis" aria-hidden>
        {buckets.map((b, i) => <span key={b}>{i % every === 0 ? bucketLabel(b, unit) : ""}</span>)}
      </div>
    </div>
  );
}
