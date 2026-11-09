"use client";

import { bangkokClock, thaiDateTime } from "@/lib/time-format";
import { useEffect, useMemo, useState } from "react";
import { HEALTH_LABEL, type HealthRow } from "@/lib/health-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";

/**
 * สุขภาพระบบ: ปกติทั้งหมด = สรุปบรรทัดเดียว กดขยายดูรายละเอียด
 * มีรายการผิดปกติ = ขยายเองและเรียงรายการผิดปกติขึ้นบน
 */
export function HealthPanel({ initial }: { initial?: HealthRow[] } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [rows, setRows] = useState<HealthRow[]>(initial ?? []);
  const [open, setOpen] = useState<boolean | null>(null);

  useEffect(() => {
    sb.from("system_health").select("check_name, ok, detail, checked_at")
      .then(({ data }) => setRows((data ?? []) as HealthRow[]));
  }, [sb]);

  const ordered = Object.keys(HEALTH_LABEL).map((k) => rows.find((r) => r.check_name === k)).filter(Boolean) as HealthRow[];
  const bad = ordered.filter((r) => !r.ok);
  const sorted = [...bad, ...ordered.filter((r) => r.ok)];
  const latest = ordered.map((r) => r.checked_at).sort().at(-1);
  const expanded = open ?? bad.length > 0;

  return (
    <section className={`card health-card ${bad.length ? "has-bad" : ""}`}>
      <div className="health-head">
        <h3>สุขภาพระบบ</h3>
        {ordered.length > 0 && (
          <button type="button" className="link-btn" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
            {expanded ? "ซ่อน" : "ดูรายละเอียด"}
          </button>
        )}
      </div>
      {ordered.length === 0 ? <p className="muted small">ยังไม่มีผลตรวจ</p> : (
        <div className={`health-summary ${bad.length ? "bad" : "ok"}`}>
          <i className={`health-dot ${bad.length ? "bad" : "ok"}`} aria-hidden />
          {bad.length ? <b>ผิดปกติ {bad.length} รายการ</b> : <b>ทุกอย่างปกติ ✓</b>}
          {latest && <span className="muted small" title={thaiDateTime(latest)}> · ตรวจล่าสุด {bangkokClock(latest)}</span>}
        </div>
      )}
      {expanded && (
        <ul className="health-list">
          {sorted.map((r) => (
            <li key={r.check_name} className={r.ok ? "" : "bad"}>
              <i className={`health-dot ${r.ok ? "ok" : "bad"}`} aria-hidden />
              <span className="health-name">{HEALTH_LABEL[r.check_name]}</span>
              <span className={`health-detail ${r.ok ? "muted" : "error"}`} title={r.detail}>{r.ok ? "ปกติ" : "ผิดปกติ"}{r.detail ? `: ${r.detail}` : ""}</span>
            </li>
          ))}
          <li className="health-foot muted small">ระบบตรวจทุก 5 นาที</li>
        </ul>
      )}
    </section>
  );
}
