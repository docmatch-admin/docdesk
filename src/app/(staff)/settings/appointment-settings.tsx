"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDays, appointmentText, bangkokToday, DEFAULT_APPOINTMENT_SETTINGS, normalizeAppointmentSettings, SUGGESTED_TEMPLATE_EN, SUGGESTED_TEMPLATE_TH, TEMPLATE_VARIABLES,
  type AppointmentSettings as Settings, type Lang, type MessageKind,
} from "@/lib/appointment-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { ClinicHoursSettings, PurposePresets, type Preset, type Slot } from "./appointment-presets";
import { InfoTip } from "./info-tip";
import { SeriesTemplates } from "./series-templates";
import { CardHead, useSaveUnit } from "./settings-save";

interface Quota { type: string; limit: number | null; used: number }
interface ChatOption { id: string; name: string; channel: string }

const PREVIEW_KINDS: [MessageKind, string][] = [["new", "นัดใหม่"], ["reminder", "เตือนก่อนวันนัด"], ["changed", "เปลี่ยนนัด"], ["cancelled", "ยกเลิก"]];

/**
 * ตั้งค่า → นัดหมาย: ข้อมูลติดต่อบนข้อความ/ใบนัด เทมเพลต เวลาเปิดคลินิก เหตุผลนัด
 * บันทึกด้วยปุ่ม "บันทึกการตั้งค่า" ของหน้า (ไม่มีปุ่มบันทึกในการ์ด)
 */
export function AppointmentSettings({ initial }: { initial?: { settings?: Settings; presets?: Preset[]; slots?: Slot[] } } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [s, setS] = useState<Settings>(initial?.settings ?? DEFAULT_APPOINTMENT_SETTINGS);
  const [stored, setStored] = useState(JSON.stringify(normalizeAppointmentSettings(initial?.settings ?? DEFAULT_APPOINTMENT_SETTINGS)));
  const [clinicName, setClinicName] = useState("คลินิก");
  const [quota, setQuota] = useState<Quota | null>(null);
  const [quotaErr, setQuotaErr] = useState("");
  const [chatQuery, setChatQuery] = useState("");
  const [chats, setChats] = useState<ChatOption[]>([]);
  const [testChat, setTestChat] = useState("");
  const [testResult, setTestResult] = useState("");
  const [previewLang, setPreviewLang] = useState<Lang | null>(null);

  useEffect(() => {
    sb.from("settings").select("key, value").in("key", ["appointment_settings", "clinic_profile"]).then(({ data }) => {
      for (const r of data ?? []) {
        if (r.key === "appointment_settings") {
          const v = normalizeAppointmentSettings(r.value);
          setS(v);
          setStored(JSON.stringify(v));
        }
        if (r.key === "clinic_profile") setClinicName((r.value as { name?: string })?.name?.trim() || "คลินิก");
      }
    });
    fetch("/api/appointments/line-quota").then(async (r) => {
      if (r.ok) setQuota(await r.json());
      else setQuotaErr((await r.json().catch(() => ({}))).error ?? "อ่านโควตาไม่สำเร็จ");
    }).catch(() => setQuotaErr("อ่านโควตาไม่สำเร็จ"));
  }, [sb]);

  // หาแชทของตัวเองจากชื่อ ใช้ฟังก์ชันค้นหาแชทเดิม
  useEffect(() => {
    const q = chatQuery.trim();
    if (q.length < 2) { setChats([]); return; }
    const t = setTimeout(async () => {
      const { data: ids } = await sb.rpc("search_conversations", { p_query: q });
      const list = ((ids ?? []) as { id: string }[]).slice(0, 10).map((r) => r.id);
      if (!list.length) return setChats([]);
      const { data } = await sb.from("conversations").select("id, contacts(display_name), channels(type)").in("id", list);
      setChats(((data ?? []) as unknown as { id: string; contacts: { display_name: string | null } | null; channels: { type: string } | null }[])
        .map((c) => ({ id: c.id, name: c.contacts?.display_name ?? "ไม่มีชื่อ", channel: c.channels?.type ?? "" })));
    }, 300);
    return () => clearTimeout(t);
  }, [sb, chatQuery]);

  const normalized = normalizeAppointmentSettings(s);
  const dirty = JSON.stringify(normalized) !== stored;
  async function save(): Promise<string | null> {
    const { error } = await sb.from("settings").upsert({ key: "appointment_settings", value: normalized, updated_at: new Date().toISOString() });
    if (error) return error.message;
    setStored(JSON.stringify(normalized));
    return null;
  }
  useSaveUnit("appointment-settings", "นัดหมาย", "appointments", dirty, save);

  async function sendTest() {
    setTestResult("กำลังส่ง…");
    const res = await fetch("/api/appointments/test-send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: testChat }) });
    const j = await res.json().catch(() => ({}));
    setTestResult(j.sent ? "ส่งแล้ว ✓ ตรวจในแชทของคุณ" : j.error ?? "ส่งไม่สำเร็จ");
  }

  const set = (patch: Partial<Settings>) => setS((cur) => ({ ...cur, ...patch }));

  // ชิปตัวแปร: แทรกลงช่อง template ที่โฟกัสล่าสุด ตรงตำแหน่งเคอร์เซอร์
  const thRef = useRef<HTMLTextAreaElement>(null);
  const enRef = useRef<HTMLTextAreaElement>(null);
  const [focusTpl, setFocusTpl] = useState<"template_th" | "template_en">("template_th");
  function insertVar(v: string) {
    const el = focusTpl === "template_th" ? thRef.current : enRef.current;
    const cur = s[focusTpl];
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    set({ [focusTpl]: cur.slice(0, start) + v + cur.slice(end) } as Partial<Settings>);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + v.length, start + v.length); });
  }

  // template ที่ยังไม่มี {mobile}: เสนอข้อความแนะนำ (ไม่เขียนทับเอง)
  const missingMobile = !s.template_th.includes("{mobile}") || !s.template_en.includes("{mobile}");
  function applySuggested() {
    set({
      ...(s.template_th.includes("{mobile}") ? {} : { template_th: SUGGESTED_TEMPLATE_TH }),
      ...(s.template_en.includes("{mobile}") ? {} : { template_en: SUGGESTED_TEMPLATE_EN }),
    });
  }

  // ตัวอย่างข้อความ: แทนตัวแปรด้วยข้อมูลตัวอย่าง ไม่ส่งจริง ใช้ค่าในฟอร์มปัจจุบัน (ยังไม่บันทึกก็ดูได้)
  const sample = useMemo(() => ({
    id: "preview", patient_name: "สมชาย ใจดี", appoint_date: addDays(bangkokToday(), 7), time_mode: "slot" as const, time_start: "08:00", time_end: "12:00",
    purpose_text: "เจาะเลือด", instructions: "งดน้ำงดอาหาร 8–12 ชม. (ดื่มน้ำเปล่าได้)",
  }), []);
  const previews = previewLang ? PREVIEW_KINDS.map(([kind, label]) => ({
    kind, label,
    text: appointmentText({
      kind, lang: previewLang, appointment: sample, settings: normalized, clinicName, includePurpose: normalized.send_purpose_in_message,
      previous: kind === "changed" ? { appoint_date: addDays(sample.appoint_date, -3), time_mode: "exact", time_start: "14:30", time_end: null } : undefined,
    }),
  })) : [];

  return (
    <section className="card appt-settings set-wide">
      <CardHead title="นัดหมาย" dirty={dirty} info="ข้อมูลติดต่อและข้อความที่ใช้ในข้อความนัด/เตือนทาง LINE Facebook Instagram และบนใบนัด · บันทึกด้วยปุ่ม “บันทึกการตั้งค่า” ด้านล่าง" />
      <div className="appt-body">
        <div className="appt-col">
          <div className="set-group">
            <h4>การติดต่อ</h4>
            <div className="set-grid">
              <label className="set-field" title="ส่งข้อความเตือนวันก่อนวันนัด เวลานี้">เวลาส่งเตือน (วันก่อนนัด)
                <input type="time" value={s.reminder_time} onChange={(e) => set({ reminder_time: e.target.value })} />
              </label>
              <label className="set-field">เบอร์คลินิก
                <input value={s.clinic_phone} onChange={(e) => set({ clinic_phone: e.target.value })} inputMode="tel" />
              </label>
              <label className="set-field">เบอร์มือถือคลินิก
                <input value={s.clinic_mobile} onChange={(e) => set({ clinic_mobile: e.target.value })} placeholder="ว่าง = ไม่แสดง" inputMode="tel" />
              </label>
            </div>
          </div>

          <div className="set-row">
            <div className="set-group">
              <h4>LINE</h4>
              <label className="set-field" title="ใช้สร้าง QR บนใบนัด">LINE OA ID
                <input value={s.line_oa_id} onChange={(e) => set({ line_oa_id: e.target.value })} placeholder="@p49clinic" />
              </label>
            </div>
            <div className="set-group span-2">
              <h4>ที่อยู่</h4>
              <label className="set-field" title="แสดงในข้อความ LINE และใบนัด">ที่อยู่คลินิก (ไทย)
                <input value={s.clinic_address} onChange={(e) => set({ clinic_address: e.target.value })} placeholder="แสดงในข้อความ LINE และใบนัด" />
              </label>
            </div>
          </div>

          <div className="set-group">
            <h4>การส่งข้อความ</h4>
            <div className="set-checks">
              <div className="set-check">
                <label className="raw"><input type="checkbox" checked={s.send_purpose_in_message} onChange={(e) => set({ send_purpose_in_message: e.target.checked })} />ใส่เหตุผลนัดในข้อความ</label>
                <small>แชทลับไม่ใส่เสมอ <InfoTip text="เหตุผลนัดจะอยู่ในข้อความนัด/เตือนเมื่อเปิดไว้ ยกเว้นแชทลับ (sensitive) ที่ไม่ใส่เสมอ การปฏิบัติตัวส่งทุกครั้งไม่ขึ้นกับตัวเลือกนี้" /></small>
              </div>
              <div className="set-check">
                <label className="raw"><input type="checkbox" checked={s.send_on_create} onChange={(e) => set({ send_on_create: e.target.checked })} />ส่งข้อความทันทีเมื่อลงนัด</label>
                <small>ปิด = LINE ส่งแค่เตือนก่อนวันนัด <InfoTip text="ปิดแล้ว LINE จะส่งแค่ข้อความเตือนก่อนวันนัด (ประหยัดโควตา) ยกเว้นคนไข้เพิ่งทักหรือเพิ่งสแกน QR ระบบตอบใบนัดดิจิทัลแบบ reply ได้ตามปกติ (ไม่นับโควตา) · Facebook/Instagram ส่งตามปกติ" /></small>
              </div>
            </div>
          </div>

          <div className="set-group">
            <div className="set-group-head">
              <h4>ข้อความนัด (template)</h4>
              <button type="button" className="btn ghost small" aria-expanded={!!previewLang} onClick={() => setPreviewLang(previewLang ? null : "th")}>
                {previewLang ? "ซ่อนตัวอย่าง" : "ดูตัวอย่างข้อความ"}
              </button>
            </div>
            <div className="set-vars" aria-label="ตัวแปร คลิกเพื่อแทรก">
              {TEMPLATE_VARIABLES.map((v) => (
                <button key={v} type="button" className="var-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => insertVar(v)} title={`แทรก ${v} ในช่อง${focusTpl === "template_th" ? "ภาษาไทย" : "ภาษาอังกฤษ"}`}>{v}</button>
              ))}
              <InfoTip text={'{time} = "เวลา 08:00–12:00 น. (ตรวจตามลำดับคิว)" หรือ "เวลา 09:30 น." · {mobile} = เบอร์มือถือ (ว่างแล้วส่วน " · มือถือ ..." หายเอง) · การปฏิบัติตัวต่อท้ายข้อความให้เสมอ · ไม่ผ่าน AI'} />
            </div>
            {missingMobile && (
              <div className="set-suggest" role="note">
                <span>ข้อความยังไม่มี {"{mobile}"} — ตอนนี้ระบบต่อท้าย “โทร/มือถือ …” เป็นบรรทัดแยกเมื่อตั้งเบอร์มือถือ</span>
                <button type="button" className="btn ghost small" onClick={applySuggested}>ใช้ข้อความแนะนำ</button>
              </div>
            )}
            <div className="set-grid tpl">
              <label className="set-field">ข้อความภาษาไทย
                <textarea ref={thRef} value={s.template_th} onFocus={() => setFocusTpl("template_th")} onChange={(e) => set({ template_th: e.target.value })} />
              </label>
              <label className="set-field">ข้อความภาษาอังกฤษ (แชทภาษาอังกฤษ)
                <textarea ref={enRef} value={s.template_en} onFocus={() => setFocusTpl("template_en")} onChange={(e) => set({ template_en: e.target.value })} title="ใช้กับแชทที่คุยภาษาอังกฤษ" />
              </label>
            </div>
            {previewLang && (
              <div className="tpl-preview" aria-live="polite">
                <div className="tpl-preview-head">
                  <span className="muted small">ข้อมูลสมมุติ ไม่ส่งจริง · ใช้ค่าในฟอร์มตอนนี้ (ยังไม่บันทึกก็ดูได้)</span>
                  <div className="segmented" role="tablist" aria-label="ภาษาตัวอย่าง">
                    <button type="button" role="tab" aria-selected={previewLang === "th"} className={previewLang === "th" ? "on" : ""} onClick={() => setPreviewLang("th")}>ไทย</button>
                    <button type="button" role="tab" aria-selected={previewLang === "en"} className={previewLang === "en" ? "on" : ""} onClick={() => setPreviewLang("en")}>English</button>
                  </div>
                </div>
                <div className="tpl-preview-grid">
                  {previews.map((p) => (
                    <div key={p.kind} className="tpl-preview-item">
                      <b>{p.label}</b>
                      <pre>{p.text}</pre>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="appt-col">
          <ClinicHoursSettings initialSlots={initial?.slots} />
          <PurposePresets initial={initial?.presets} />
          <div className="set-group">
            <h4>ภาษาอังกฤษ (ใบนัด EN)</h4>
            <div className="set-grid">
              <label className="set-field">ชื่อคลินิก English
                <input value={s.clinic_name_en} onChange={(e) => set({ clinic_name_en: e.target.value })} />
              </label>
              <label className="set-field">ที่อยู่ภาษาอังกฤษ (address_en)
                <input value={s.clinic_address_en} onChange={(e) => set({ clinic_address_en: e.target.value })} placeholder="e.g. 49 Sukhumvit Rd, Bangkok" />
              </label>
            </div>
          </div>

          <details className="set-more">
            <summary>Template ชุดนัด (วัคซีนหลายเข็ม)</summary>
            <SeriesTemplates />
          </details>
          <details className="set-more">
            <summary>ส่งทดสอบหาตัวเอง · โควตา LINE</summary>
            <div className="set-more-body">
              <p className="muted small set-note">ทักแชท LINE ของคลินิกจากบัญชีตัวเองก่อน แล้วค้นชื่อแชทนั้น (Facebook/Instagram ต้องทักภายใน 24 ชม.)</p>
              <div className="row">
                <input style={{ flex: 1, width: "auto" }} placeholder="ค้นชื่อแชทของคุณ" value={chatQuery} onChange={(e) => setChatQuery(e.target.value)} />
                <select style={{ flex: 1, width: "auto" }} value={testChat} onChange={(e) => setTestChat(e.target.value)} aria-label="แชทที่จะส่งทดสอบ">
                  <option value="">เลือกแชท</option>
                  {chats.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.channel})</option>)}
                </select>
                <button className="btn ghost" disabled={!testChat} onClick={sendTest}>ส่งทดสอบ</button>
              </div>
              {testResult && <div className="small">{testResult}</div>}
              {quota ? (
                <div className="small">
                  โควตา LINE เดือนนี้: ใช้ไป <b>{quota.used.toLocaleString("th-TH")}</b>
                  {quota.limit != null ? <> / {quota.limit.toLocaleString("th-TH")} ข้อความ (เหลือ {(quota.limit - quota.used).toLocaleString("th-TH")})</> : " ข้อความ (ไม่จำกัด)"}
                </div>
              ) : <div className="muted small">{quotaErr || "กำลังโหลดโควตา…"}</div>}
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
