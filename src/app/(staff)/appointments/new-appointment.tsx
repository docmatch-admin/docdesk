"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { thaiShortDate } from "@/lib/appointment-rules";
import { bangkokClock } from "@/lib/time-format";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { Icon } from "../icons";
import { AppointmentForm, deliveryText, EMPTY_DRAFT, type AppointmentDraft } from "./appointment-form";

interface Visit { hn: string; name: string; doctor: string; time: string; phone: string; seq?: number }
interface Patient { hn: string; name: string; phone: string; lineLinked?: boolean; lastAppointment?: string | null }

/** 0812345678 → 081-XXX-5678 (ปิดกลางในรายการ ค่าเต็มใช้เติมฟอร์ม) */
export const maskPhone = (p: string) => {
  const d = p.replace(/\D/g, "");
  if (d.length === 10) return `${d.slice(0, 3)}-XXX-${d.slice(6)}`;
  if (d.length === 9) return `${d.slice(0, 2)}-XXX-${d.slice(5)}`;
  return d ? "XXX" : "";
};
/** หน้านัดหมายทำนัดได้เฉพาะคนไข้ที่มี HN คนไข้ใหม่ทำนัดจากแชท */
type Source = "today" | "search";

const SOURCES: [Source, string][] = [["today", "คนไข้วันนี้"], ["search", "ค้นหา"]];

/** เวลาจาก iService อาจเป็น "13:45:00" หรือ ISO ตัดให้เหลือ HH:MM */
const clock = (t: string) => t.match(/(\d{1,2}):(\d{2})/)?.slice(1, 3).map((x, i) => (i === 0 ? x.padStart(2, "0") : x)).join(":") ?? t;
/** HN 000004714 → 4714 อ่านง่ายกว่า (ค่าที่บันทึกยังเป็น HN เต็ม) */
export const shortHn = (hn: string) => hn.replace(/^0+(?=\d)/, "");
/** ชื่อหมอจาก HIS มักมีช่องว่างซ้อน */
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

function Steps({ step }: { step: 1 | 2 }) {
  return (
    <ol className="appt-steps" aria-label="ขั้นตอนทำนัด">
      <li className={step === 1 ? "on" : "done"} aria-current={step === 1 ? "step" : undefined}><span>①</span> เลือกคนไข้</li>
      <li aria-hidden="true" className="appt-steps-arrow">→</li>
      <li className={step === 2 ? "on" : ""} aria-current={step === 2 ? "step" : undefined}><span>②</span> รายละเอียดนัด</li>
    </ol>
  );
}

/**
 * ทำนัดใหม่จากหน้านัดหมาย (flow หลักของห้องยา)
 * ขั้น 1 เลือกคนไข้จาก visit วันนี้ / ค้นหาใน iService (HN ชื่อ เบอร์) → ขั้น 2 ฟอร์มนัด → เปิดหน้าพิมพ์ใบนัด
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
  const [selectedHn, setSelectedHn] = useState("");
  const [booked, setBooked] = useState<Set<string>>(new Set());
  // iService ล่ม: แสดงข้อมูลจาก cache พร้อมเวลาที่ดึงล่าสุด
  const [cachedAt, setCachedAt] = useState<string | null>(null);

  async function call<T>(body: Record<string, unknown>): Promise<T | null> {
    const { data, error } = await sb.functions.invoke("iservice", { body });
    if (error) {
      setErr("เชื่อมต่อ iService ไม่สำเร็จ — ลองใหม่อีกครั้ง หรือคนไข้ใหม่ให้ทำนัดจากแชท");
      return null;
    }
    return data as T;
  }

  useEffect(() => {
    if (source !== "today" || visits) return;
    setLoading(true);
    call<{ visits: Visit[]; cached?: boolean; cachedAt?: string | null }>({ action: "visits" }).then((d) => {
      setVisits(d?.visits ?? []);
      setCachedAt(d?.cached ? d.cachedAt ?? "" : null);
    }).finally(() => setLoading(false));
  }, [source]);

  // HN ที่มีนัดในอนาคตแล้ว แสดงป้าย "มีนัดแล้ว"
  useEffect(() => {
    fetch("/api/appointments?upcoming_hns=1").then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setBooked(new Set((j.hns as string[]).map((h) => h.trim())))).catch(() => {});
  }, []);

  // ค้นอัตโนมัติหลังหยุดพิมพ์ 300ms
  useEffect(() => {
    if (source !== "search") return;
    const t = setTimeout(() => { void runSearch(); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, source]);

  const isNameQuery = /[^\d\s-]/.test(query.trim());

  async function search(e: React.FormEvent) {
    e.preventDefault();
    await runSearch();
  }

  async function runSearch() {
    const q = query.trim();
    if (!q || (isNameQuery && q.length < 2)) { setPatients(null); return; }
    setErr("");
    setLoading(true);
    const d = await call<{ patients: Patient[]; cached?: boolean; cachedAt?: string | null }>({ action: "patients", q: query.trim() });
    setPatients(d?.patients ?? []);
    setCachedAt(d?.cached ? d.cachedAt ?? "" : null);
    setLoading(false);
  }

  /**
   * เลือกคนไข้: เปิดฟอร์มด้วยชื่อจากรายการ แล้วฟอร์มดึงชื่อ + เบอร์จาก iService เอง (ผ่าน /api/appointments/form-data ฝั่ง server)
   * ทางเดียวกับทุกทางเข้า (คนไข้วันนี้ ค้นหา กล่องขวาของแชท แก้ไขนัด) · ผู้นัดเริ่มว่าง
   * (เดิมเติมเบอร์ที่นี่หลังเปิดฟอร์มแล้ว แต่ฟอร์มรับค่า initial ครั้งเดียว เบอร์จึงไม่ขึ้น)
   */
  function pick(p: { hn: string; name: string; phone?: string; doctor?: string }) {
    setHisName(p.name);
    setSelectedHn(p.hn);
    setDraft({ ...EMPTY_DRAFT, hn: p.hn, patient_name: p.name, phone: p.phone ?? "", provider: "" });
  }

  function chooseSource(k: Source) {
    setSource(k);
    setErr("");
    setCachedAt(null);
  }

  const shownVisits = (visits ?? []).filter((v) => {
    const q = visitFilter.trim().toLowerCase();
    return !q || v.hn.includes(q) || shortHn(v.hn).includes(q) || v.name.toLowerCase().includes(q) || v.doctor.toLowerCase().includes(q);
  });

  if (draft) {
    return (
      <section className="card appt-new">
        <div className="appt-new-head">
          <Steps step={2} />
          <button type="button" className="btn ghost small" onClick={onClose}>ปิด</button>
        </div>
        <div className="appt-patient-bar">
          <div className="appt-patient-name">
            <b>{draft.patient_name || "คนไข้ใหม่"}</b>
            {draft.hn && <span className="muted small">HN {shortHn(draft.hn)}</span>}
          </div>
          <button type="button" className="btn ghost small" onClick={() => setDraft(null)}>← เปลี่ยนคนไข้</button>
        </div>
        <AppointmentForm key={draft.hn} initial={draft} hisName={hisName || undefined} lockHn saveLabel="บันทึก & พิมพ์ใบนัด" onCancel={onClose}
          onSaved={(r) => router.push(`/appointments/${r.appointment.id}/print?msg=${encodeURIComponent(deliveryText(r.delivery))}&sent=${r.delivery?.sent ? 1 : 0}`)} />
      </section>
    );
  }

  return (
    <section className="card appt-new">
      <div className="appt-new-head">
        <Steps step={1} />
        <button type="button" className="btn ghost small" onClick={onClose}>ปิด</button>
      </div>

      <div className="appt-pick-toolbar">
        <div className="segmented" role="tablist" aria-label="วิธีเลือกคนไข้">
          {SOURCES.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={source === k} className={source === k ? "on" : ""} onClick={() => chooseSource(k)}>{label}</button>
          ))}
        </div>
        {source === "today" && (
          <label className="search-box">
            <Icon name="search" size={16} />
            <input autoFocus type="search" aria-label="ค้นหาคนไข้วันนี้" placeholder="ค้นหา HN / ชื่อ / หมอ" value={visitFilter} onChange={(e) => setVisitFilter(e.target.value)} />
          </label>
        )}
        {source === "search" && (
          <form className="search-box with-button" onSubmit={search}>
            <Icon name="search" size={16} />
            <input autoFocus type="search" aria-label="ค้นหาคนไข้เก่า" placeholder="HN, เบอร์โทร หรือชื่อ (คนไข้ที่เคยนัด)" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className="btn primary small" disabled={loading || !query.trim()}>ค้นหา</button>
          </form>
        )}
      </div>
      {err && <div className="error small" role="alert">{err}</div>}
      {cachedAt !== null && (
        <div className="appt-cache-bar" role="status">
          iService ไม่ตอบสนอง — แสดงข้อมูล ณ {cachedAt ? bangkokClock(cachedAt) : "ล่าสุดที่มี"} น. (ทำนัดต่อได้ตามปกติ)
        </div>
      )}

      {source === "today" && (
        <>
          <div className="appt-pick-meta">
            {loading ? "กำลังโหลด visit วันนี้…" : visits ? `วันนี้ ${visits.length} ราย${visitFilter.trim() ? ` · ตรงกับคำค้น ${shownVisits.length} ราย` : ""}` : ""}
          </div>
          {visits && !shownVisits.length && !loading && <div className="appt-empty small">ไม่พบคนไข้ที่ค้นหา</div>}
          {shownVisits.length > 0 && (
            <div className="appt-pick-list" role="list">
              {shownVisits.map((v, i) => (
                <button type="button" role="listitem" key={`${v.hn}-${v.time}-${i}`} className={`appt-pick ${selectedHn === v.hn ? "selected" : ""}`} onClick={() => pick(v)}>
                  <span className="appt-pick-time">{v.time ? clock(v.time) : v.seq ? `#${v.seq}` : "–"}</span>
                  <span className="appt-pick-main">
                    <span className="appt-pick-name">{v.name || "ไม่มีชื่อ"}</span>
                    <span className="appt-pick-hn">HN {shortHn(v.hn)}</span>
                  </span>
                  <span className="appt-pick-side">
                    <span className="appt-pick-doctor">{tidy(v.doctor)}</span>
                    {booked.has(v.hn.trim()) && <span className="chip tiny appt-booked">มีนัดแล้ว</span>}
                  </span>
                  {/* จอแคบ: บรรทัดสอง HN · หมอ */}
                  <span className="appt-pick-sub" aria-hidden="true">HN {shortHn(v.hn)}{v.doctor ? ` · ${tidy(v.doctor)}` : ""}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {source === "search" && (
        <>
          {loading && <div className="appt-pick-meta">กำลังค้นหา…</div>}
          {isNameQuery && <div className="appt-pick-meta">ค้นด้วยชื่อได้เฉพาะคนไข้ที่เคยนัด — ค้นจาก iService ใช้ HN หรือเบอร์</div>}
          {patients && !patients.length && !loading && (
            <div className="appt-empty small">{isNameQuery ? "ไม่พบคนไข้ที่เคยนัดชื่อนี้ — ลองค้นด้วย HN หรือเบอร์" : "ไม่พบใน iService — ถ้าเป็นคนไข้ใหม่ ให้ทำนัดจากแชทของคนไข้"}</div>
          )}
          {!!patients?.length && (
            <div className="appt-pick-list" role="list">
              {patients.map((p) => (
                <button type="button" role="listitem" key={p.hn} className={`appt-pick ${selectedHn === p.hn ? "selected" : ""}`} onClick={() => pick(p)}>
                  <span className="appt-pick-time">{p.lineLinked ? <span className="chip tiny ch-line" title="ผูกแชท LINE แล้ว">LINE ✓</span> : null}</span>
                  <span className="appt-pick-main">
                    <span className="appt-pick-name">{p.name || "ไม่มีชื่อ"}</span>
                    <span className="appt-pick-hn">HN {shortHn(p.hn)}{p.phone ? ` · ${maskPhone(p.phone)}` : ""}</span>
                  </span>
                  <span className="appt-pick-side">
                    {p.lastAppointment && <span className="appt-pick-doctor">นัดล่าสุด {thaiShortDate(p.lastAppointment)}</span>}
                    {booked.has(p.hn.trim()) && <span className="chip tiny appt-booked">มีนัดแล้ว</span>}
                  </span>
                  <span className="appt-pick-sub" aria-hidden="true">HN {shortHn(p.hn)}{p.phone ? ` · ${maskPhone(p.phone)}` : ""}{p.lineLinked ? " · LINE ✓" : ""}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
