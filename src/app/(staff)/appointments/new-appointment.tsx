"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { AppointmentForm, deliveryText, EMPTY_DRAFT, type AppointmentDraft } from "./appointment-form";

interface Visit { hn: string; name: string; doctor: string; time: string; phone: string; seq?: number }
interface Patient { hn: string; name: string; phone: string }
type Source = "today" | "search" | "manual";

/** เวลาจาก iService อาจเป็น "13:45:00" หรือ ISO ตัดให้เหลือ HH:MM */
const clock = (t: string) => t.match(/(\d{1,2}):(\d{2})/)?.slice(1, 3).join(":") ?? t;

/**
 * ทำนัดใหม่จากหน้านัดหมาย (flow หลักของห้องยา)
 * ขั้น 1 เลือกคนไข้จาก visit วันนี้ / ค้นหาคนไข้เก่า / กรอกเอง → ขั้น 2 ฟอร์มนัด → เปิดหน้าพิมพ์ใบนัด
 */
export function NewAppointment({ onClose }: { onClose: () => void }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const router = useRouter();
  const [source, setSource] = useState<Source>("today");
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [visitFilter, setVisitFilter] = useState("");
  const [query, setQuery] = useState("");
  const [patients, setPatients] = useState<Patient[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState<AppointmentDraft | null>(null);
  const [hisName, setHisName] = useState("");

  async function call<T>(body: Record<string, unknown>): Promise<T | null> {
    const { data, error } = await sb.functions.invoke("iservice", { body });
    if (error) {
      setErr("เชื่อมต่อ iService ไม่สำเร็จ — ค้นหาคนไข้เก่าหรือกรอกเองได้");
      return null;
    }
    return data as T;
  }

  useEffect(() => {
    if (source !== "today" || visits) return;
    setLoading(true);
    call<{ visits: Visit[] }>({ action: "visits" }).then((d) => setVisits(d?.visits ?? [])).finally(() => setLoading(false));
  }, [source]);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim().length < 2) return;
    setErr("");
    setLoading(true);
    const d = await call<{ patients: Patient[] }>({ action: "patients", q: query.trim() });
    setPatients(d?.patients ?? []);
    setLoading(false);
  }

  /** เติมเบอร์จาก patient_list ถ้า visit ไม่มีเบอร์ ผู้นัดเริ่มต้น = หมอที่ตรวจ visit นั้น */
  async function pick(p: { hn: string; name: string; phone?: string; doctor?: string }) {
    let phone = p.phone ?? "";
    setHisName(p.name);
    setDraft({ ...EMPTY_DRAFT, hn: p.hn, patient_name: p.name, phone, provider: p.doctor ?? "" });
    if (!phone && p.hn) {
      const d = await call<{ patient: Patient | null }>({ action: "patient", hn: p.hn });
      phone = d?.patient?.phone ?? "";
      if (phone) setDraft((cur) => (cur && cur.hn === p.hn && !cur.phone ? { ...cur, phone } : cur));
    }
  }

  const shownVisits = (visits ?? []).filter((v) => {
    const q = visitFilter.trim().toLowerCase();
    return !q || v.hn.includes(q) || v.name.toLowerCase().includes(q) || v.doctor.toLowerCase().includes(q);
  });

  if (draft) {
    return (
      <section className="card appt-new">
        <div className="row between">
          <h3>ขั้น 2 · นัดคุณ{draft.patient_name || "…"} {draft.hn && <span className="muted small">HN {draft.hn}</span>}</h3>
          <button type="button" className="btn ghost small" onClick={() => setDraft(null)}>← เปลี่ยนคนไข้</button>
        </div>
        <AppointmentForm initial={draft} hisName={hisName || undefined} saveLabel="บันทึก & พิมพ์ใบนัด" onCancel={onClose}
          onSaved={(r) => router.push(`/appointments/${r.appointment.id}/print?msg=${encodeURIComponent(deliveryText(r.delivery))}&sent=${r.delivery?.sent ? 1 : 0}`)} />
      </section>
    );
  }

  return (
    <section className="card appt-new">
      <div className="row between">
        <h3>ขั้น 1 · เลือกคนไข้</h3>
        <button type="button" className="btn ghost small" onClick={onClose}>ปิด</button>
      </div>
      <div className="tabs wide" role="tablist">
        {([["today", "คนไข้วันนี้"], ["search", "ค้นหาคนไข้เก่า"], ["manual", "กรอกเอง"]] as [Source, string][]).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={source === k} className={source === k ? "on" : ""}
            onClick={() => { setSource(k); setErr(""); if (k === "manual") { setHisName(""); setDraft({ ...EMPTY_DRAFT }); } }}>{label}</button>
        ))}
      </div>
      {err && <div className="error small" role="alert">{err}</div>}

      {source === "today" && (
        <>
          <input autoFocus placeholder="ค้นหา HN / ชื่อ / หมอ" value={visitFilter} onChange={(e) => setVisitFilter(e.target.value)} />
          {loading && <div className="muted small">กำลังโหลด visit วันนี้…</div>}
          {visits && !shownVisits.length && !loading && <div className="muted small">ไม่พบ visit</div>}
          <div className="appt-pick-list">
            {shownVisits.map((v, i) => (
              <button type="button" key={`${v.hn}-${v.time}-${i}`} className="appt-pick" onClick={() => pick(v)}>
                <span className="appt-pick-time">{v.time ? clock(v.time) : v.seq ? `คิว ${v.seq}` : ""}</span>
                <span className="appt-pick-name">{v.name || "ไม่มีชื่อ"}<span className="muted small"> HN {v.hn}</span></span>
                <span className="muted small">{v.doctor}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {source === "search" && (
        <>
          <form className="row" onSubmit={search}>
            <input autoFocus className="grow" placeholder="HN หรือชื่อ (อย่างน้อย 2 ตัว)" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, width: "auto" }} />
            <button className="btn primary" disabled={loading}>ค้นหา</button>
          </form>
          {loading && <div className="muted small">กำลังค้นหา…</div>}
          {patients && !patients.length && !loading && <div className="muted small">ไม่พบคนไข้ — กรอกเองได้</div>}
          <div className="appt-pick-list">
            {(patients ?? []).map((p) => (
              <button type="button" key={p.hn} className="appt-pick" onClick={() => pick(p)}>
                <span className="appt-pick-time">HN {p.hn}</span>
                <span className="appt-pick-name">{p.name}</span>
                <span className="muted small">{p.phone}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
