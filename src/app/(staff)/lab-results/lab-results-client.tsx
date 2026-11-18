"use client";

import { useCallback, useEffect, useState } from "react";
import { LAB_TABS, NOTIFY_LABEL, parseLabTab, type LabResult, type LabSummary, type LabTab } from "@/lib/lab-results-rules";

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
  if (v.reason === "no_liff") return "ยังไม่ได้ตั้งค่า LIFF — ยังไม่ส่งแจ้งคนไข้";
  if (v.reason === "unmatched") return "ยังไม่ได้จับคู่คนไข้";
  return `ส่งไม่สำเร็จ${v.error ? `: ${v.error}` : ""}`;
}

export function LabResultsClient({ isAdmin, initialId, initialTab }: { isAdmin: boolean; initialId: string | null; initialTab: string | null }) {
  const [tab, setTab] = useState<LabTab>(parseLabTab(initialTab));
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [summary, setSummary] = useState<LabSummary | null>(null);
  const [onlyId, setOnlyId] = useState<string | null>(initialId);
  const [rows, setRows] = useState<LabResult[]>([]);
  const [sync, setSync] = useState<SyncInfo | null>(null);
  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [appts, setAppts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [matching, setMatching] = useState<string | null>(null);
  const [hn, setHn] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [groupInput, setGroupInput] = useState("");

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(null), 3500); };

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams({ tab, q, from, to });
    if (onlyId) p.set("id", onlyId);
    const res = await fetch(`/api/lab-results?${p}`).catch(() => null);
    const j = res?.ok ? await res.json() : null;
    setRows(j?.results ?? []);
    setSync(j?.sync ?? null);
    setSummary(j?.summary ?? null);
    setGroup(j?.group ?? null);
    setAppts(j?.appointments ?? {});
    setLoading(false);
  }, [tab, q, from, to, onlyId]);

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
      <div className="lab-head">
        <div>
          <h1>ผลแล็บ</h1>
          <p className="muted small">Bangkok Medical Lab · ดึงอัตโนมัติชั่วโมงละครั้ง 13:00–18:00 น.</p>
        </div>
        <span className={`lab-sync ${sync?.last_error ? "bad" : sync?.last_ok_at ? "ok" : ""}`} title={sync?.last_error ?? undefined}>
          {sync?.last_error ? "ดึงรอบล่าสุดไม่สำเร็จ" : sync?.last_ok_at ? `ดึงสำเร็จล่าสุด ${whenTh(sync.last_ok_at)}` : "ยังไม่เคยดึงผล"}
        </span>
      </div>
      {sync?.last_error && <p className="error small">รอบล่าสุดผิดพลาด: {sync.last_error}</p>}

      {summary && (
        <div className="lab-cards">
          <div className="card lab-card"><span className="muted small">ผลใหม่วันนี้</span><b>{summary.today}</b></div>
          <button type="button" className={`card lab-card warn ${tab === "unmatched" ? "on" : ""}`} onClick={() => { setOnlyId(null); setTab("unmatched"); }}>
            <span className="muted small">รอจับคู่</span><b>{summary.unmatched}</b>
          </button>
          <button type="button" className={`card lab-card ${tab === "unviewed" ? "on" : ""}`} onClick={() => { setOnlyId(null); setTab("unviewed"); }}>
            <span className="muted small">คนไข้ยังไม่เปิดดู</span><b>{summary.unviewed}</b>
          </button>
        </div>
      )}

      <div className="lab-toolbar">
        <div className="lab-tabs" role="tablist">
          {LAB_TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`btn small ${tab === t.key ? "primary" : "ghost"}`}
              onClick={() => { setOnlyId(null); setTab(t.key); }}>{t.label}</button>
          ))}
        </div>
        <div className="lab-filters">
          <input className="lab-search" type="search" placeholder="ค้นชื่อ / HN / LN" value={q} onChange={(e) => { setOnlyId(null); setQ(e.target.value); }} />
          <label className="lab-date">ตั้งแต่<input type="date" value={from} onChange={(e) => { setOnlyId(null); setFrom(e.target.value); }} /></label>
          <label className="lab-date">ถึง<input type="date" value={to} onChange={(e) => { setOnlyId(null); setTo(e.target.value); }} /></label>
          {(from || to) && <button type="button" className="link-btn small" onClick={() => { setFrom(""); setTo(""); }}>ล้างวันที่</button>}
        </div>
      </div>
      {onlyId && <p className="small">แสดงรายการจากลิงก์ · <button type="button" className="link-btn" onClick={() => setOnlyId(null)}>ดูทั้งหมด</button></p>}

      <section className="card">
        {loading && !rows.length && <div className="muted small">กำลังโหลด…</div>}
        {!loading && !rows.length && <div className="muted small">ไม่มีรายการ</div>}
        {rows.length > 0 && (
          <div className="report-table-wrap">
            <table className="report-table lab-table">
              <thead>
                <tr><th scope="col">คนไข้</th><th scope="col">สั่งตรวจ</th><th scope="col">แจ้งคนไข้</th><th scope="col">คนไข้เปิดดู</th><th scope="col">นัดฟังผล</th><th scope="col" className="lab-act">จัดการ</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const unmatched = r.match_status === "unmatched";
                  const hnText = hnOf(r);
                  return (
                    <tr key={r.id} className={unmatched ? "lab-row-unmatched" : undefined}>
                      <td className="lab-who">
                        <b>{r.patient_name || "–"}</b>
                        <div className="muted small">{r.patient_id ? `HN ${hnText}` : "ยังไม่รู้ HN"}{r.ln ? ` · LN ${r.ln}` : ""}</div>
                        {(unmatched || r.version_number > 1 || r.match_status === "manual") && (
                          <div className="lab-tags">
                            {unmatched && <span className="lab-chip bad">รอจับคู่</span>}
                            {unmatched && r.location_hn && <span className="muted small">แล็บอ่านได้: {r.location_hn}</span>}
                            {r.match_status === "manual" && <span className="lab-chip">จับคู่เอง</span>}
                            {r.version_number > 1 && <span className="lab-chip wait">แก้ผล v{r.version_number}</span>}
                          </div>
                        )}
                      </td>
                      <td data-label="สั่งตรวจ">{whenTh(r.order_datetime)}</td>
                      <td data-label="แจ้งคนไข้">
                        <span className={NOTIFY_CLASS[r.notify_status]} title={r.notify_error ?? undefined}>{NOTIFY_LABEL[r.notify_status]}</span>
                        {r.notified_at && r.notify_status === "sent" && <div className="muted small">{whenTh(r.notified_at)}</div>}
                        {r.notify_error && (r.notify_status === "failed" || r.notify_status === "sent") && (
                          <details className="lab-error"><summary>{r.notify_status === "failed" ? "ดูสาเหตุ" : "ส่งไม่ถึงบางบัญชี"}</summary><div>{r.notify_error}</div></details>
                        )}
                      </td>
                      <td data-label="คนไข้เปิดดู">
                        {r.first_viewed_at
                          ? <span className="lab-viewed">{whenTh(r.first_viewed_at)}{r.view_count > 1 && <span className="muted small"> · {r.view_count} ครั้ง</span>}</span>
                          : <span className="muted">{r.notify_status === "sent" ? "ยังไม่เปิด" : "–"}</span>}
                      </td>
                      <td data-label="นัดฟังผล">{r.patient_id && appts[r.patient_id] ? appts[r.patient_id] : <span className="muted">–</span>}</td>
                      <td className="lab-act">
                        <div className="lab-actions">
                          {unmatched && (
                            <button type="button" className="btn small primary lab-match-btn"
                              onClick={() => { setMatching(matching === r.id ? null : r.id); setHn((r.location_hn ?? "").replace(/\D/g, "").slice(0, 9)); }}>
                              จับคู่คนไข้
                            </button>
                          )}
                          {r.pdf_path
                            ? <a className="btn ghost small" href={`/api/lab-results/${r.id}/pdf`} target="_blank" rel="noopener noreferrer">ดู PDF</a>
                            : <span className="muted small" title={r.pdf_error ?? undefined}>{r.pdf_error ? "โหลดไฟล์ไม่สำเร็จ" : "รอไฟล์"}</span>}
                          {!unmatched && (
                            <button type="button" className="link-btn small"
                              onClick={() => { setMatching(matching === r.id ? null : r.id); setHn(r.patient_id?.replace(/^0+/, "") ?? ""); }}>
                              เปลี่ยนคนไข้
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {isAdmin && group && (
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
