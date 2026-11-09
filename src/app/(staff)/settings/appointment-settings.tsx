"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_APPOINTMENT_SETTINGS, normalizeAppointmentSettings, TEMPLATE_VARIABLES,
  type AppointmentSettings as Settings,
} from "@/lib/appointment-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { ClinicHoursSettings, PurposePresets, type Preset, type Slot } from "./appointment-presets";
import { InfoTip } from "./info-tip";
import { SeriesTemplates } from "./series-templates";

interface Quota { type: string; limit: number | null; used: number }
interface ChatOption { id: string; name: string; channel: string }

/** ตั้งค่า → นัดหมาย: เวลาเตือน เทมเพลต ข้อมูลคลินิกบนข้อความ/ใบนัด ส่งทดสอบ และโควตา LINE */
export function AppointmentSettings({ initial }: { initial?: { settings?: Settings; presets?: Preset[]; slots?: Slot[] } } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [s, setS] = useState<Settings>(initial?.settings ?? DEFAULT_APPOINTMENT_SETTINGS);
  const [saved, setSaved] = useState("");
  const [quota, setQuota] = useState<Quota | null>(null);
  const [quotaErr, setQuotaErr] = useState("");
  const [chatQuery, setChatQuery] = useState("");
  const [chats, setChats] = useState<ChatOption[]>([]);
  const [testChat, setTestChat] = useState("");
  const [testResult, setTestResult] = useState("");

  useEffect(() => {
    sb.from("settings").select("value").eq("key", "appointment_settings").maybeSingle()
      .then(({ data }) => setS(normalizeAppointmentSettings(data?.value)));
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

  async function save() {
    const { error } = await sb.from("settings").upsert({ key: "appointment_settings", value: normalizeAppointmentSettings(s), updated_at: new Date().toISOString() });
    setSaved(error ? `บันทึกไม่สำเร็จ: ${error.message}` : "บันทึกแล้ว ✓");
    setTimeout(() => setSaved(""), 3000);
  }

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

  return (
    <section className="card appt-settings">
      <h3>📅 นัดหมาย</h3>

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
            <input value={s.clinic_mobile} onChange={(e) => set({ clinic_mobile: e.target.value })} placeholder="ว่าง = ไม่แสดง (เช่น 081-234-5678)" inputMode="tel" />
          </label>
        </div>
      </div>

      {/* LINE (1 คอลัมน์) กับที่อยู่ (2 คอลัมน์) อยู่แถวเดียวกันเมื่อจอกว้าง */}
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
        <h4>ภาษาอังกฤษ (ใบนัด EN)</h4>
        <div className="set-grid">
          <label className="set-field">ชื่อคลินิก English
            <input value={s.clinic_name_en} onChange={(e) => set({ clinic_name_en: e.target.value })} />
          </label>
          <label className="set-field span-2">ที่อยู่ภาษาอังกฤษ (address_en)
            <input value={s.clinic_address_en} onChange={(e) => set({ clinic_address_en: e.target.value })} placeholder="e.g. 49 Sukhumvit Rd, Bangkok" />
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
        <h4>ข้อความนัด (template)</h4>
        <div className="set-vars" aria-label="ตัวแปร คลิกเพื่อแทรก">
          {TEMPLATE_VARIABLES.map((v) => (
            <button key={v} type="button" className="var-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => insertVar(v)} title={`แทรก ${v} ในช่อง${focusTpl === "template_th" ? "ภาษาไทย" : "ภาษาอังกฤษ"}`}>{v}</button>
          ))}
          <InfoTip text={'{time} = "เวลา 08:00–12:00 น. (ตรวจตามลำดับคิว)" หรือ "เวลา 09:30 น." · {mobile} = เบอร์มือถือ (ว่างแล้วบรรทัดนั้นหายไป ไม่ใส่ใน template ระบบต่อท้ายให้) · การปฏิบัติตัวต่อท้ายข้อความให้เสมอ · ไม่ผ่าน AI'} />
        </div>
        <div className="set-grid tpl">
          <label className="set-field">ข้อความภาษาไทย
            <textarea ref={thRef} value={s.template_th} onFocus={() => setFocusTpl("template_th")} onChange={(e) => set({ template_th: e.target.value })} />
          </label>
          <label className="set-field">ข้อความภาษาอังกฤษ (แชทภาษาอังกฤษ)
            <textarea ref={enRef} value={s.template_en} onFocus={() => setFocusTpl("template_en")} onChange={(e) => set({ template_en: e.target.value })} title="ใช้กับแชทที่คุยภาษาอังกฤษ" />
          </label>
        </div>
      </div>

      <div className="set-save">
        <button className="btn primary" onClick={save}>บันทึกการตั้งค่านัดหมาย</button>
        <span className="small">{saved}</span>
      </div>

      <PurposePresets initial={initial?.presets} />
      <ClinicHoursSettings initialSlots={initial?.slots} />
      <details className="set-more">
        <summary>Template ชุดนัด (วัคซีนหลายเข็ม)</summary>
        <SeriesTemplates />
      </details>

      <details className="set-more">
        <summary>ส่งทดสอบหาตัวเอง · โควตา LINE เดือนนี้</summary>
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
    </section>
  );
}
