"use client";

import { useEffect, useMemo, useState } from "react";
import { thaiDateTime } from "@/lib/time-format";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { SetLine } from "./settings-save";

export interface RetentionRun {
  id: number; started_at: string; finished_at: string | null; tasks_deleted: number; notes_deleted: number;
  appointments_deleted: number; events_deleted: number; series_deleted: number; batches: number; error: string | null;
}

/** log รอบลบถาวรล่าสุด (admin อ่านได้เท่านั้น) */
export function RetentionRuns({ initial }: { initial?: RetentionRun[] } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [rows, setRows] = useState<RetentionRun[]>(initial ?? []);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (initial) return;
    sb.from("retention_runs").select("*").order("started_at", { ascending: false }).limit(10)
      .then(({ data, error }) => { setErr(error ? "โหลดประวัติการลบไม่สำเร็จ" : ""); if (!error) setRows((data ?? []) as RetentionRun[]); });
  }, [sb, initial]);
  return (
    <SetLine label="ประวัติการลบ" desc="10 รอบล่าสุด (วันละครั้ง 03:00)">
      {err && <span className="error small">{err}</span>}
      {!err && rows.length === 0 && <span className="muted">ยังไม่มีรอบที่ทำงาน</span>}
      {rows.length > 0 && (
        <ul className="retention-runs">
          {rows.map((r) => (
            <li key={r.id} className={r.error ? "bad" : ""}>
              <time dateTime={r.started_at}>{thaiDateTime(r.started_at)}</time>
              <span>งาน {r.tasks_deleted} (คอมเมนต์ {r.notes_deleted}) · นัดยกเลิก {r.appointments_deleted} (log {r.events_deleted}{r.series_deleted ? `, ชุดนัด ${r.series_deleted}` : ""})</span>
              {r.error ? <span className="error">ผิดพลาด: {r.error}</span> : !r.finished_at && <span className="muted">กำลังทำงาน/ไม่จบ</span>}
            </li>
          ))}
        </ul>
      )}
    </SetLine>
  );
}
