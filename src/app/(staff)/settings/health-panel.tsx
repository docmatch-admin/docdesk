"use client";

import { bangkokClock, thaiDateTime } from "@/lib/time-format";
import { useEffect, useMemo, useState } from "react";
import { HEALTH_LABEL, type HealthRow } from "@/lib/health-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { SetGroup, SetLine, useTabAlert } from "./settings-save";

/** สุขภาพระบบ: รายการสถานะเป็นแถว ผิดปกติเรียงขึ้นบน (ไม่มีส่วนพับ) */
export function HealthPanel({ initial }: { initial?: HealthRow[] } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [rows, setRows] = useState<HealthRow[]>(initial ?? []);

  useEffect(() => {
    sb.from("system_health").select("check_name, ok, detail, checked_at")
      .then(({ data }) => setRows((data ?? []) as HealthRow[]));
  }, [sb]);

  const ordered = Object.keys(HEALTH_LABEL).map((k) => rows.find((r) => r.check_name === k)).filter(Boolean) as HealthRow[];
  const bad = ordered.filter((r) => !r.ok);
  const sorted = [...bad, ...ordered.filter((r) => r.ok)];
  const latest = ordered.map((r) => r.checked_at).sort().at(-1);
  useTabAlert("health", "overview", bad.length > 0);

  return (
    <SetGroup title="สุขภาพระบบ" area="health" className={bad.length ? "has-bad" : ""} info="ระบบตรวจการเชื่อมต่อทุก 5 นาที (ฐานข้อมูล OpenAI LINE Meta เว็บไซต์)"
      side={ordered.length > 0 && (
        <span className={`health-summary ${bad.length ? "bad" : "ok"}`}>
          <b>{bad.length ? `ผิดปกติ ${bad.length} รายการ` : "ทุกอย่างปกติ"}</b>
          {latest && <span className="muted small" title={thaiDateTime(latest)}> · ตรวจล่าสุด {bangkokClock(latest)}</span>}
        </span>
      )}>
      {ordered.length === 0 ? <p className="muted small">ยังไม่มีผลตรวจ</p> : sorted.map((r) => (
        <SetLine key={r.check_name} label={HEALTH_LABEL[r.check_name]}>
          <span className={`health-status ${r.ok ? "ok" : "bad"}`}>
            <i className={`health-dot ${r.ok ? "ok" : "bad"}`} aria-hidden />
            <b>{r.ok ? "ปกติ" : "ผิดปกติ"}</b>
            {r.detail && <span className={r.ok ? "muted" : "error"}>{r.detail}</span>}
          </span>
        </SetLine>
      ))}
    </SetGroup>
  );
}
