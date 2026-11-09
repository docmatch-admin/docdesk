"use client";

import { isClosedDate, type ClinicSchedule } from "@/lib/appointment-rules";

export type DayCounts = Record<string, { total: number; slots: Record<string, number> }>;

const MONTH_TH = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const WEEK = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

const shift = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  return d.toISOString().slice(0, 7);
};

/** ปฏิทินเลือกวันนัด แสดงจำนวนนัดต่อวัน วันปิดเป็นสีส้ม */
export function MonthCalendar({ month, onMonth, selected, min, counts, schedule, onPick }: {
  month: string;
  onMonth: (m: string) => void;
  selected: string;
  min: string;
  counts: DayCounts;
  schedule: ClinicSchedule;
  onPick: (date: string) => void;
}) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1, 12));
  const days = new Date(Date.UTC(y, m, 0, 12)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: first.getUTCDay() }, () => null),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  const canPrev = shift(month, -1) >= min.slice(0, 7);

  return (
    <div className="appt-cal" role="group" aria-label="ปฏิทินเลือกวันนัด">
      <div className="appt-cal-head">
        <button type="button" className="btn ghost small" disabled={!canPrev} onClick={() => onMonth(shift(month, -1))} aria-label="เดือนก่อน">‹</button>
        <b>{MONTH_TH[m - 1]} {y + 543}</b>
        <button type="button" className="btn ghost small" onClick={() => onMonth(shift(month, 1))} aria-label="เดือนถัดไป">›</button>
      </div>
      <div className="appt-cal-grid">
        {WEEK.map((w) => <div key={w} className="appt-cal-w">{w}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} />;
          const past = d < min;
          const closed = isClosedDate(d, schedule);
          const n = counts[d]?.total ?? 0;
          return (
            <button type="button" key={d} disabled={past} onClick={() => onPick(d)}
              className={`appt-cal-day ${d === selected ? "on" : ""} ${closed ? "closed" : ""}`}
              aria-label={`${Number(d.slice(8))} ${MONTH_TH[m - 1]}${closed ? " คลินิกปิด" : ""} นัดแล้ว ${n} ราย`}>
              <span>{Number(d.slice(8))}</span>
              {n > 0 && <span className="appt-cal-n">{n}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
