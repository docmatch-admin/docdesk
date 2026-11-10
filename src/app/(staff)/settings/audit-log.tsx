"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { thaiDateTime } from "@/lib/time-format";
import { AUDIT_ACTION_LABEL, AUDIT_TABLE_LABEL, auditChanges, type AuditRow } from "@/lib/settings-audit";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { SetGroup } from "./settings-save";

const SECTIONS = ["ทั้งหมด", "นัดหมาย", "แชทและแท็ก", "AI", "ทีมและระบบ"];
const PAGE = 50;

/** ประวัติการแก้ตั้งค่า: ใคร เมื่อไร หมวด ค่าเก่า→ใหม่ (admin เท่านั้น ฐานข้อมูลก็ให้อ่านเฉพาะ admin) */
export function AuditLog({ initial }: { initial?: AuditRow[] } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [rows, setRows] = useState<AuditRow[]>(initial ?? []);
  const [section, setSection] = useState("ทั้งหมด");
  const [limit, setLimit] = useState(PAGE);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    let q = sb.from("settings_audit").select("id, actor_id, actor_name, section, table_name, record_key, action, old_value, new_value, created_at")
      .order("created_at", { ascending: false }).limit(limit);
    if (section !== "ทั้งหมด") q = q.eq("section", section);
    const { data, error } = await q;
    setErr(error ? "โหลดประวัติไม่สำเร็จ" : "");
    if (!error) setRows((data ?? []) as AuditRow[]);
  }, [sb, section, limit]);
  useEffect(() => { if (!initial) load(); }, [load, initial]);

  return (
    <SetGroup title="ประวัติการแก้ตั้งค่า" area="audit" info="ทุกการแก้ตั้งค่าจากหน้าเว็บ ทั้ง admin และ agent · ตั้งค่าส่วนตัว (การแสดงผล) ไม่บันทึก"
      side={
        <select aria-label="กรองตามหมวด" value={section} onChange={(e) => { setSection(e.target.value); setLimit(PAGE); }} className="audit-filter">
          {SECTIONS.map((s) => <option key={s}>{s}</option>)}
        </select>
      }>
      {err && <p className="error small">{err}</p>}
      {rows.length === 0 && !err && <p className="muted small slist-msg">ยังไม่มีประวัติ</p>}
      <ul className="audit-list">
        {rows.map((r) => {
          const changes = auditChanges(r);
          return (
            <li key={r.id} className="audit-row">
              <div className="audit-meta">
                <b>{r.actor_name ?? "ระบบ"}</b>
                <span className={`audit-action ${r.action}`}>{AUDIT_ACTION_LABEL[r.action]}</span>
                <span>{AUDIT_TABLE_LABEL[r.table_name] ?? r.table_name}{r.record_key ? ` · ${r.record_key}` : ""}</span>
                <span className="audit-section">{r.section}</span>
                <time className="audit-time" dateTime={r.created_at}>{thaiDateTime(r.created_at)}</time>
              </div>
              {changes.length > 0 && (
                <ul className="audit-changes">
                  {changes.slice(0, 6).map((c) => (
                    <li key={c.field}><code>{c.field}</code> <span className="audit-old">{c.from}</span> → <span className="audit-new">{c.to}</span></li>
                  ))}
                  {changes.length > 6 && <li className="muted">และอีก {changes.length - 6} รายการ</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {rows.length >= limit && <button type="button" className="slist-add" onClick={() => setLimit((l) => l + PAGE)}>ดูเพิ่ม</button>}
    </SetGroup>
  );
}
