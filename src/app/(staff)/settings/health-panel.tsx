"use client";

import { thaiDateTime } from "@/lib/time-format";
import { useEffect, useMemo, useState } from "react";
import { HEALTH_LABEL, type HealthRow } from "@/lib/health-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";

const timeTh = (iso: string) => thaiDateTime(iso);

export function HealthPanel() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [rows, setRows] = useState<HealthRow[]>([]);

  useEffect(() => {
    sb.from("system_health").select("check_name, ok, detail, checked_at")
      .then(({ data }) => setRows((data ?? []) as HealthRow[]));
  }, [sb]);

  const ordered = Object.keys(HEALTH_LABEL).map((k) => rows.find((r) => r.check_name === k)).filter(Boolean) as HealthRow[];

  return (
    <section className="card">
      <h3>สุขภาพระบบ</h3>
      {ordered.length === 0 && <p className="muted small">ยังไม่มีผลตรวจ</p>}
      {ordered.map((r) => (
        <div key={r.check_name} className="row between ch-row">
          <span><i className={`health-dot ${r.ok ? "ok" : "bad"}`} aria-hidden /> {HEALTH_LABEL[r.check_name]}</span>
          <span className={r.ok ? "muted small" : "error small"}>{r.ok ? "ปกติ" : "ผิดปกติ"}: {r.detail}</span>
        </div>
      ))}
      {ordered[0] && <p className="muted small">ตรวจล่าสุด {timeTh(ordered[0].checked_at)} ระบบตรวจทุก 5 นาที</p>}
    </section>
  );
}
