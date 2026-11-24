"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { LabDrawer } from "./lab-drawer";
import { LAB_TABS, lastLabPage, NOTIFY_LABEL, parseLabTab, type LabResult, type LabSummary, type LabTab } from "@/lib/lab-results-rules";

interface SyncInfo { last_ok_at: string | null; last_run_at: string | null; last_error: string | null }
interface GroupInfo { group_id?: string | null; candidate_id?: string | null; candidate_at?: string | null }

const dateTh = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("th-TH", { dateStyle: "medium", timeZone: "Asia/Bangkok" }) : "–");
export const whenTh = (iso: string | null) => {
  if (!iso) return "–";
  const t = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" }).format(new Date(iso));
  return `${dateTh(iso)} ${t}`;
};
/** ในตาราง: "17 พ.ย. 14:50" (ปีปัจจุบันไม่แสดงปี) ให้อยู่บรรทัดเดียว */
const shortTh = (iso: string | null) => {
  if (!iso) return "–";
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const day = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "2-digit" }), timeZone: "Asia/Bangkok" }).format(d);
  const t = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" }).format(d);
  return `${day} ${t}`;
};
/** คำขอนัดฟังผลจากคนไข้ (LIFF) ที่รอเจ้าหน้าที่ลงนัด */
export interface HearingRequestView { id: string; conversation_id: string; date: string; time: string; when: string }
const shortReq = (q: HearingRequestView) => shortTh(`${q.date}T${q.time}:00+07:00`);
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

/** ตัวแบ่งหน้าใต้ตาราง: อยู่ที่เดิมเสมอ ปุ่มที่กดไม่ได้จางลง (ไม่ซ่อน) */
export function LabPager({ page, total, loading, onPage }: { page: number; total: number; loading: boolean; onPage: (p: number) => void }) {
  const last = lastLabPage(total);
  return (
    <nav className="lab-pager" aria-label="แบ่งหน้าผลแล็บ">
      <button type="button" className="btn ghost small" disabled={page <= 1 || loading} onClick={() => onPage(page - 1)}>‹ ก่อนหน้า</button>
      <span className="lab-pager-info" aria-live="polite">หน้า {page} / {last} (ทั้งหมด {total} รายการ)</span>
      <button type="button" className="btn ghost small" disabled={page >= last || loading} onClick={() => onPage(page + 1)}>ถัดไป ›</button>
    </nav>
  );
}

export function LabResultsClient({ isAdmin, initialId, initialTab }: { isAdmin: boolean; initialId: string | null; initialTab: string | null }) {
  const [tab, setTab] = useState<LabTab>(parseLabTab(initialTab));
  const [q, setQ] = useState("");
  // ค้นหา: พิมพ์หยุด 300 ms ค่อยยิง
  const [qDebounced, setQDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [summary, setSummary] = useState<LabSummary | null>(null);
  const [onlyId, setOnlyId] = useState<string | null>(initialId);
  const [rows, setRows] = useState<LabResult[]>([]);
  const [sync, setSync] = useState<SyncInfo | null>(null);
  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [appts, setAppts] = useState<Record<string, string>>({});
  const [lineReady, setLineReady] = useState<Record<string, boolean>>({});
  const [requests, setRequests] = useState<Record<string, HearingRequestView>>({});
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialId);
  const [busy, setBusy] = useState<string | null>(null);
  const [groupInput, setGroupInput] = useState("");

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(null), 3500); };

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  // เปลี่ยนแท็บ / ค้นหา / วันที่ = กลับหน้า 1
  useEffect(() => { setPage(1); }, [tab, qDebounced, from, to, onlyId]);

  const load = useCallback(async () => {
    // ยกเลิกคำขอเก่าที่ยังไม่เสร็จ · แถวเดิมยังแสดงระหว่างโหลด (ไม่กระพริบว่าง)
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    const p = new URLSearchParams({ tab, q: qDebounced, from, to, page: String(page) });
    if (onlyId) p.set("id", onlyId);
    const res = await fetch(`/api/lab-results?${p}`, { signal: ctrl.signal }).catch(() => null);
    if (ctrl.signal.aborted) return;
    const j = res?.ok ? await res.json().catch(() => null) : null;
    if (ctrl.signal.aborted) return;
    if (j) {
      setRows(j.results ?? []);
      setTotal(j.total ?? (j.results ?? []).length);
      if (typeof j.page === "number" && j.page !== page) setPage(j.page);
      setSync(j.sync ?? null);
      setSummary(j.summary ?? null);
      setGroup(j.group ?? null);
      setAppts(j.appointments ?? {});
      setLineReady(j.lineReady ?? {});
      setRequests(j.requests ?? {});
    }
    setLoading(false);
  }, [tab, qDebounced, from, to, onlyId, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => abortRef.current?.abort(), []);

  async function patch(id: string, body: Record<string, unknown>, okText: (j: Record<string, unknown>) => string) {
    setBusy(id);
    const res = await fetch(`/api/lab-results/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const j = (res ? await res.json().catch(() => ({})) : {}) as Record<string, unknown>;
    setBusy(null);
    if (!res?.ok) return flash(String(j.error ?? "ทำรายการไม่สำเร็จ"));
    flash(okText(j));
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

  /** มือถือ (ตามแบบ): บรรทัดสั้น ๆ บอกว่าต้องทำอะไรต่อ */
  const mobileNote = (r: LabResult) => {
    if (r.match_status === "unmatched") return "ต้องผูกคนไข้ก่อน";
    const parts: string[] = [];
    if (r.first_viewed_at) parts.push(`เปิดดูแล้ว ${shortTh(r.first_viewed_at)}`);
    if (r.patient_id && appts[r.patient_id]) parts.push(`นัดฟังผล ${appts[r.patient_id]}`);
    else if (r.patient_id && requests[r.patient_id]) parts.push(`คนไข้ขอ ${shortReq(requests[r.patient_id])} · รอยืนยัน`);
    if (parts.length) return parts.join(" · ");
    if (r.notify_status === "pending") return "ระบบจะส่งในรอบถัดไป";
    if (r.notify_status === "unreachable") return r.patient_id && lineReady[r.patient_id] ? "ผูก LINE แล้ว · รอส่ง" : "ไม่ต้องทำอะไร";
    if (r.notify_status === "failed") return "กดดูรายละเอียด";
    if (r.notify_status === "sent") return "ยังไม่เปิดดู";
    return "";
  };
  const tabCount = (k: LabTab) => (k === "unmatched" ? summary?.unmatched : k === "unviewed" ? summary?.unviewed : 0) ?? 0;

  return (
    <div className="page lab-page">
      <div className="lab-m m-page">
        <header className="m-page-head with-back">
          <Link href="/menu" className="m-back" aria-label="กลับไปเมนู"><Icon name="chevronLeft" size={22} /></Link>
          <h1>ผลแล็บ</h1>
        </header>
        <div className="lab-m-tabs" role="tablist" aria-label="กรองผลแล็บ">
          {LAB_TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "on" : ""}
              onClick={() => { setOnlyId(null); setTab(t.key); }}>{t.label}{tabCount(t.key) > 0 && ` ${tabCount(t.key)}`}</button>
          ))}
        </div>
        <div className="m-page-body">
          <section className="m-card lab-m-list">
            {loading && !rows.length && <div className="muted small">กำลังโหลด…</div>}
            {!loading && !rows.length && <div className="muted small">ไม่มีรายการ</div>}
            {onlyId && <p className="small">แสดงรายการจากลิงก์ · <button type="button" className="link-btn" onClick={() => setOnlyId(null)}>ดูทั้งหมด</button></p>}
            {rows.map((r) => {
              const unmatched = r.match_status === "unmatched";
              const chip = r.notify_status === "unreachable" && r.patient_id && lineReady[r.patient_id] ? "lab-chip wait" : NOTIFY_CLASS[r.notify_status];
              return (
                <div key={r.id} className={`lab-m-item ${unmatched ? "unmatched" : ""}`} onClick={() => setSelected(r.id)}>
                  <div className="lab-m-top">
                    <span className="lab-m-name">{r.patient_name || "–"}<span className="muted"> · {r.patient_id ? `HN ${hnOf(r)}` : "ไม่พบ HN"}</span></span>
                    <span className="lab-m-date">{shortTh(r.order_datetime)}</span>
                  </div>
                  <div className="lab-m-meta">
                    <span className={chip}>{NOTIFY_LABEL[r.notify_status]}</span>
                    {r.version_number > 1 && <span className="lab-chip wait">แก้ผล v{r.version_number}</span>}
                    <span className="muted">{mobileNote(r)}</span>
                  </div>
                  {unmatched
                    ? <button type="button" className="lab-m-btn" onClick={(e) => { e.stopPropagation(); setSelected(r.id); }}>ผูกคนไข้ (ใส่ HN)</button>
                    : r.pdf_path
                      ? <a className="lab-m-btn" href={`/api/lab-results/${r.id}/pdf`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>ดู PDF</a>
                      : <button type="button" className="lab-m-btn" disabled>{r.pdf_error ? "ไฟล์มีปัญหา" : "รอไฟล์ผล"}</button>}
                </div>
              );
            })}
          </section>
          <LabPager page={page} total={total} loading={loading} onPage={setPage} />
        </div>
      </div>
      <div className="lab-head">
        <div>
          <h1>ผลแล็บ</h1>
          <p className="muted small">Bangkok Medical Lab · ดึงอัตโนมัติทุก 30 นาที 13:00–18:00 น.</p>
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
            <span className="muted small">ไม่พบ HN</span><b>{summary.unmatched}</b>
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
          <label className="search-box lab-search"><Icon name="search" size={16} /><input type="search" aria-label="ค้นชื่อ / HN" placeholder="ค้นชื่อ / HN" value={q} onChange={(e) => { setOnlyId(null); setQ(e.target.value); }} /></label>
          <label className="lab-date">ตั้งแต่<input type="date" value={from} onChange={(e) => { setOnlyId(null); setFrom(e.target.value); }} /></label>
          <label className="lab-date">ถึง<input type="date" value={to} onChange={(e) => { setOnlyId(null); setTo(e.target.value); }} /></label>
          {(from || to) && <button type="button" className="link-btn small" onClick={() => { setFrom(""); setTo(""); }}>ล้างวันที่</button>}
        </div>
      </div>
      {onlyId && <p className="small">แสดงรายการจากลิงก์ · <button type="button" className="link-btn" onClick={() => setOnlyId(null)}>ดูทั้งหมด</button></p>}

      <section className={`card lab-results-list ${loading && rows.length ? "lab-loading" : ""}`} aria-busy={loading}>
        {loading && !rows.length && <div className="muted small">กำลังโหลด…</div>}
        {!loading && !rows.length && <div className="muted small">ไม่มีรายการ</div>}
        {rows.length > 0 && (
          <div className="report-table-wrap">
            <table className="report-table lab-table">
              <thead>
                <tr><th scope="col">คนไข้</th><th scope="col">สั่งตรวจ</th><th scope="col">แจ้งคนไข้</th><th scope="col">คนไข้เปิดดู</th><th scope="col">นัดฟังผล</th><th scope="col" className="lab-pdf-col"><span className="sr-only">ไฟล์ผล</span></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const unmatched = r.match_status === "unmatched";
                  const cls = ["lab-click", unmatched ? "lab-row-unmatched" : "", selected === r.id ? "on" : ""].filter(Boolean).join(" ");
                  return (
                    <tr key={r.id} className={cls} onClick={() => setSelected(r.id)}>
                      <td className="lab-who">
                        <button type="button" className="lab-open" onClick={(e) => { e.stopPropagation(); setSelected(r.id); }}>{r.patient_name || "–"}</button>
                        <span className="muted small">{r.patient_id ? ` · HN ${hnOf(r)}` : ""}</span>
                        {unmatched && <span className="lab-chip bad">ไม่พบ HN</span>}
                        {r.version_number > 1 && <span className="lab-chip wait">แก้ผล v{r.version_number}</span>}
                        {!r.pdf_path && <span className="lab-chip">{r.pdf_error ? "ไฟล์มีปัญหา" : "รอไฟล์"}</span>}
                      </td>
                      <td data-label="สั่งตรวจ">{shortTh(r.order_datetime)}</td>
                      <td data-label="แจ้งคนไข้">
                        {r.notify_status === "unreachable" && r.patient_id && lineReady[r.patient_id]
                          ? <span className="lab-chip wait">ผูก LINE แล้ว · รอส่ง</span>
                          : <span className={NOTIFY_CLASS[r.notify_status]}>{NOTIFY_LABEL[r.notify_status]}</span>}
                        {r.notified_at && r.notify_status === "sent" && <span className="muted small"> {shortTh(r.notified_at)}</span>}
                      </td>
                      <td data-label="คนไข้เปิดดู">
                        {r.first_viewed_at
                          ? <span className="lab-viewed">{shortTh(r.first_viewed_at)}{r.view_count > 1 && <span className="muted small"> · {r.view_count} ครั้ง</span>}</span>
                          : <span className="muted">{r.notify_status === "sent" ? "ยังไม่เปิด" : "–"}</span>}
                      </td>
                      <td data-label="นัดฟังผล">{r.patient_id && appts[r.patient_id]
                        ? appts[r.patient_id]
                        : r.patient_id && requests[r.patient_id]
                          ? <span className="lab-chip wait">คนไข้ขอ {shortReq(requests[r.patient_id])} · รอยืนยัน</span>
                          : <span className="muted">–</span>}</td>
                      <td className="lab-pdf-col" onClick={(e) => e.stopPropagation()}>
                        {r.pdf_path
                          ? <a className="btn ghost small" href={`/api/lab-results/${r.id}/pdf`} target="_blank" rel="noopener noreferrer">ดู PDF</a>
                          : <button type="button" className="btn ghost small" disabled title={r.pdf_error ? "โหลดไฟล์ไม่สำเร็จ" : "ยังไม่มีไฟล์"}>ดู PDF</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <LabPager page={page} total={total} loading={loading} onPage={setPage} />

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
      {(() => {
        const cur = selected ? rows.find((x) => x.id === selected) : null;
        return cur ? (
          <LabDrawer r={cur} lineReady={!!(cur.patient_id && lineReady[cur.patient_id])} appt={cur.patient_id ? appts[cur.patient_id] ?? null : null} request={cur.patient_id ? requests[cur.patient_id] ?? null : null} busy={busy === cur.id}
            onClose={() => setSelected(null)} onPatch={patch} whenTh={whenTh} notifyClass={NOTIFY_CLASS[cur.notify_status]} notifyText={notifyText} />
        ) : null;
      })()}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
