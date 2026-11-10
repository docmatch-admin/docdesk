"use client";

import { useEffect, useMemo, useState } from "react";
import { CANCEL_REASON_LABEL, bangkokToday, type CancelReason } from "@/lib/appointment-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";
import type { MonthlySummary as Summary } from "@/lib/retention-store";

const sortDesc = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]);

/**
 * สรุปรายเดือน (admin): งานที่เสร็จต่อผู้รับ นัดยกเลิกต่อเหตุผล
 * รวมตัวเลขของงาน/นัดที่ถูกลบตามนโยบายเก็บข้อมูลแล้ว เดือนเก่าจึงยังได้ตัวเลขเดิม
 */
export function MonthlySummary() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [month, setMonth] = useState(() => bangkokToday().slice(0, 7));
  const [data, setData] = useState<Summary | null>(null);
  const [err, setErr] = useState("");
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    sb.from("staff").select("id, display_name").then(({ data: s }) =>
      setNames(new Map(((s ?? []) as { id: string; display_name: string }[]).map((x) => [x.id, x.display_name]))));
  }, [sb]);
  useEffect(() => {
    setErr("");
    fetch(`/api/reports/monthly?month=${month}`).then(async (r) => {
      if (r.ok) setData(await r.json()); else setErr((await r.json().catch(() => ({}))).error ?? "โหลดไม่สำเร็จ");
    }).catch(() => setErr("โหลดไม่สำเร็จ"));
  }, [month]);

  const total = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
  return (
    <section className="card monthly-summary">
      <div className="row between">
        <h3>สรุปรายเดือน</h3>
        <label className="raw small">เดือน <input type="month" value={month} max={bangkokToday().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} /></label>
      </div>
      <p className="muted small">รวมงานและนัดยกเลิกที่ถูกลบตามนโยบายเก็บข้อมูลแล้ว (นับจากตัวเลขที่เก็บไว้ก่อนลบ)</p>
      {err && <p className="error small">{err}</p>}
      {data && (
        <div className="monthly-grid">
          <div>
            <h4>งานที่เสร็จ · {total(data.tasksByAssignee)}</h4>
            <ul>{sortDesc(data.tasksByAssignee).map(([k, n]) => <li key={k}><span>{k === "none" ? "ไม่ระบุผู้รับ" : names.get(k) ?? "เจ้าหน้าที่ที่ลบแล้ว"}</span><b>{n}</b></li>)}</ul>
          </div>
          <div>
            <h4>นัดยกเลิก · {total(data.cancelledByReason)}</h4>
            <ul>{sortDesc(data.cancelledByReason).map(([k, n]) => <li key={k}><span>{k === "none" ? "ไม่ระบุเหตุผล" : CANCEL_REASON_LABEL[k as CancelReason] ?? k}</span><b>{n}</b></li>)}</ul>
          </div>
          <div>
            <h4>นัดยกเลิกตามเหตุผลนัด</h4>
            <ul>{sortDesc(data.cancelledByPurpose).map(([k, n]) => <li key={k}><span>{k === "none" ? "ไม่ระบุ" : k}</span><b>{n}</b></li>)}</ul>
          </div>
        </div>
      )}
    </section>
  );
}
