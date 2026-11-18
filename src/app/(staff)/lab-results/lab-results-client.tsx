"use client";

import { useCallback, useEffect, useState } from "react";
import { LAB_TABS, MATCH_LABEL, NOTIFY_LABEL, parseLabTab, type LabResult, type LabTab } from "@/lib/lab-results-rules";

interface SyncInfo { last_ok_at: string | null; last_run_at: string | null; last_error: string | null }
interface GroupInfo { group_id?: string | null; candidate_id?: string | null; candidate_at?: string | null }

const dateTh = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("th-TH", { dateStyle: "medium", timeZone: "Asia/Bangkok" }) : "–");
export const whenTh = (iso: string | null) => {
  if (!iso) return "–";
  const t = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" }).format(new Date(iso));
  return `${dateTh(iso)} ${t}`;
};
const hnOf = (r: LabResult) => (r.patient_id ? r.patient_id.replace(/^0+/, "") : r.location_hn?.trim() || null);
export const NOTIFY_CLASS: Record<LabResult["notify_status"], string> = {
  pending: "lab-chip wait", sent: "lab-chip ok", unreachable: "lab-chip", failed: "lab-chip bad", skipped: "lab-chip",
};

export function notifyText(n: unknown): string {
  const v = n as { sent?: boolean; accounts?: number; reason?: string; error?: string } | null;
  if (!v) return "บันทึกแล้ว";
  if (v.sent) return `ส่งแจ้งคนไข้ทาง LINE แล้ว${(v.accounts ?? 1) > 1 ? ` (${v.accounts} บัญชี)` : ""}`;
  if (v.reason === "unreachable") return "คนไข้ไม่ได้ผูก LINE — ไม่ได้ส่งแจ้ง";
  if (v.reason === "no_pdf") return "ยังไม่มีไฟล์ผล รอรอบดึงถัดไป";
  if (v.reason === "unmatched") return "ยังไม่ได้จับคู่คนไข้";
  return `ส่งไม่สำเร็จ${v.error ? `: ${v.error}` : ""}`;
}

export function LabResultsClient({ isAdmin, initialId, initialTab }: { isAdmin: boolean; initialId: string | null; initialTab: string | null }) {
  const [tab, setTab] = useState<LabTab>(parseLabTab(initialTab));
  const [q, setQ] = useState("");
  const [onlyId, setOnlyId] = useState<string | null>(initialId);
  const [rows, setRows] = useState<LabResult[]>([]);
  const [sync, setSync] = useState<SyncInfo | null>(null);
  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [matching, setMatching] = useState<string | null>(null);
  const [hn, setHn] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [groupInput, setGroupInput] = useState("");

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(null), 3500); };

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams({ tab, q });
    if (onlyId) p.set("id", onlyId);
    const res = await fetch(`/api/lab-results?${p}`).catch(() => null);
    const j = res?.ok ? await res.json() : null;
    setRows(j?.results ?? []);
    setSync(j?.sync ?? null);
    setGroup(j?.group ?? null);
    setLoading(false);
  }, [tab, q, onlyId]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function patch(id: string, body: Record<string, unknown>, okText: (j: Record<string, unknown>) => string) {
    setBusy(id);
    const res = await fetch(`/api/lab-results/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const j = (res ? await res.json().catch(() => ({})) : {}) as Record<string, unknown>;
    setBusy(null);
    if (!res?.ok) return flash(String(j.error ?? "ทำรายการไม่สำเร็จ"));
    flash(okText(j));
    setMatching(null);
    load();
  }

  async function saveGroup(id: string | null) {
    const res = await fetch("/api/lab-results/team-group", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ group_id: id }) }).catch(() => null);
    const j = (res ? await res.json().catch(() => ({})) : {}) as { error?: string; group?: GroupInfo };
    if (!res?.ok) return flash(j.error ?? "บันทึกไม่สำเร็จ");
    setGroup(j.group ?? null);
    setGroupInput("");
    flash(id ? "ตั้งกลุ่มแจ้งทีมแล้ว" : "ปิดการแจ้งทีมแล้ว");
  }

  return (
    <div className="page lab-page">
      <h1>ผลแล็บ</h1>
      <p className="muted small">
        ดึงจาก Bangkok Medical Lab ชั่วโมงละครั้ง 13:00–18:00 น. · ดึงสำเร็จล่าสุด {whenTh(sync?.last_ok_at ?? null)}
        {sync?.last_error && <span className="error"> · รอบล่าสุดผิดพลาด: {sync.last_error}</span>}
      </p>

      <div className="lab-toolbar">
        <div className="lab-tabs" role="tablist">
          {LAB_TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`btn small ${tab === t.key ? "primary" : "ghost"}`}
              onClick={() => { setOnlyId(null); setTab(t.key); }}>{t.label}</button>
          ))}
        </div>
        <input className="lab-search" type="search" placeholder="ค้นชื่อ / HN / LN" value={q} onChange={(e) => { setOnlyId(null); setQ(e.target.value); }} />
      </div>
      {onlyId && <p className="small">แสดงรายการจากลิงก์ · <button type="button" className="link-btn" onClick={() => setOnlyId(null)}>ดูทั้งหมด</button></p>}

      <section className="card">
        {loading && !rows.length && <div className="muted small">กำลังโหลด…</div>}
        {!loading && !rows.length && <div className="muted small">ไม่มีรายการ</div>}
        {rows.length > 0 && (
          <div className="report-table-wrap">
            <table className="report-table lab-table">
              <thead>
                <tr><th scope="col">ชื่อ</th><th scope="col">HN</th><th scope="col">สั่งตรวจ</th><th scope="col">จับคู่</th><th scope="col">แจ้งคนไข้</th><th scope="col">คนไข้เปิดดู</th><th scope="col">จัดการ</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <b>{r.patient_name || "–"}</b>
                      <div className="muted small">{r.ln ? `LN ${r.ln}` : ""}{r.version_number > 1 ? ` · ฉบับแก้ไข v${r.version_number}` : ""}</div>
                    </td>
                    <td>{hnOf(r) ?? "–"}</td>
                    <td>{whenTh(r.order_datetime)}</td>
                    <td>
                      <span className={`lab-chip ${r.match_status === "unmatched" ? "bad" : "ok"}`}>{MATCH_LABEL[r.match_status]}</span>
                      {r.match_status === "unmatched" && r.location_hn && <div className="muted small">แล็บอ่านได้: {r.location_hn}</div>}
                    </td>
                    <td>
                      <span className={NOTIFY_CLASS[r.notify_status]} title={r.notify_error ?? undefined}>{NOTIFY_LABEL[r.notify_status]}</span>
                      {r.notified_at && <div className="muted small">{whenTh(r.notified_at)}</div>}
                    </td>
                    <td>{r.first_viewed_at ? <>{whenTh(r.first_viewed_at)}<div className="muted small">{r.view_count} ครั้ง</div></> : <span className="muted">ยังไม่เปิด</span>}</td>
                    <td>
                      <div className="lab-actions">
                        {r.pdf_path
                          ? <a className="btn ghost small" href={`/api/lab-results/${r.id}/pdf`} target="_blank" rel="noopener noreferrer">ดู PDF</a>
                          : <span className="muted small" title={r.pdf_error ?? undefined}>{r.pdf_error ? "โหลดไฟล์ไม่สำเร็จ" : "รอไฟล์"}</span>}
                        <button type="button" className="btn ghost small"
                          onClick={() => { setMatching(matching === r.id ? null : r.id); setHn(r.patient_id?.replace(/^0+/, "") ?? (r.location_hn ?? "").replace(/\D/g, "").slice(0, 9)); }}>
                          {r.patient_id ? "เปลี่ยนคนไข้" : "จับคู่คนไข้"}
                        </button>
                        {r.patient_id && r.pdf_path && (
                          <button type="button" className="btn ghost small" disabled={busy === r.id}
                            onClick={() => patch(r.id, { action: "resend" }, (j) => notifyText(j.notify))}>
                            {r.notify_status === "sent" ? "ส่งแจ้งซ้ำ" : "ส่งแจ้ง"}
                          </button>
                        )}
                        {matching === r.id && (
                          <form className="lab-match" onSubmit={(e) => {
                            e.preventDefault();
                            patch(r.id, { action: "match", hn }, (j) => (j.matched ? `จับคู่แล้ว · ${notifyText(j.notify)}` : "ยกเลิกการจับคู่แล้ว"));
                          }}>
                            <input inputMode="numeric" placeholder="HN" value={hn} onChange={(e) => setHn(e.target.value.replace(/\D/g, "").slice(0, 9))} aria-label="HN คนไข้" />
                            <button type="submit" className="btn primary small" disabled={busy === r.id}>{hn ? "บันทึก" : "ยกเลิกจับคู่"}</button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {isAdmin && (
        <section className="card lab-group">
          <h3>แจ้งทีมในกลุ่ม LINE</h3>
          <p className="muted small">ผลใหม่ทุกรายการ (และฉบับที่แล็บแก้) ส่งชื่อ, HN และลิงก์ดูใน DocDesk เข้ากลุ่ม ให้แพทย์ดูก่อน ไม่ส่งค่าผลตรวจ</p>
          <p className="small">
            กลุ่มปัจจุบัน: {group?.group_id ? <code>{group.group_id}</code> : <span className="muted">ยังไม่ตั้ง (ไม่แจ้งทีม)</span>}
            {group?.group_id && <> · <button type="button" className="link-btn" onClick={() => saveGroup(null)}>ปิด</button></>}
          </p>
          {group?.candidate_id && group.candidate_id !== group.group_id && (
            <p className="small">
              OA เพิ่งถูกเชิญเข้ากลุ่ม <code>{group.candidate_id}</code> ({whenTh(group.candidate_at ?? null)}) ·{" "}
              <button type="button" className="btn primary small" onClick={() => saveGroup(group.candidate_id!)}>ใช้กลุ่มนี้</button>
            </p>
          )}
          <p className="muted small">วิธีตั้ง: เปิด &quot;อนุญาตให้เข้าร่วมแชทกลุ่ม&quot; ใน LINE OA Manager แล้วเชิญ OA เข้ากลุ่มแพทย์/ทีม จากนั้นกด &quot;ใช้กลุ่มนี้&quot; หรือใส่ Group ID เอง</p>
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (groupInput.trim()) saveGroup(groupInput.trim()); }}>
            <input placeholder="Group ID (ขึ้นต้นด้วย C)" value={groupInput} onChange={(e) => setGroupInput(e.target.value)} style={{ maxWidth: 360 }} />
            <button type="submit" className="btn ghost small" disabled={!groupInput.trim()}>บันทึก</button>
          </form>
        </section>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
