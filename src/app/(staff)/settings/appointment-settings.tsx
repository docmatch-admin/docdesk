"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_APPOINTMENT_SETTINGS, normalizeAppointmentSettings, TEMPLATE_VARIABLES,
  type AppointmentSettings as Settings,
} from "@/lib/appointment-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { ClinicHoursSettings, PurposePresets } from "./appointment-presets";

interface Quota { type: string; limit: number | null; used: number }
interface ChatOption { id: string; name: string; channel: string }

/** ตั้งค่า → นัดหมาย: เวลาเตือน เทมเพลต ข้อมูลคลินิกบนข้อความ/ใบนัด ส่งทดสอบ และโควตา LINE */
export function AppointmentSettings() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [s, setS] = useState<Settings>(DEFAULT_APPOINTMENT_SETTINGS);
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

  return (
    <section className="card appt-settings">
      <h3>📅 นัดหมาย</h3>
      <div className="appt-grid">
        <label>เวลาส่งเตือน (วันก่อนนัด)
          <input type="time" value={s.reminder_time} onChange={(e) => set({ reminder_time: e.target.value })} />
        </label>
        <label>เบอร์คลินิก<input value={s.clinic_phone} onChange={(e) => set({ clinic_phone: e.target.value })} /></label>
        <label className="span2">LINE OA ID (สำหรับ QR บนใบนัด)<input value={s.line_oa_id} onChange={(e) => set({ line_oa_id: e.target.value })} placeholder="@p49clinic" /></label>
        <label className="span4">ที่อยู่คลินิก (แสดงในข้อความ LINE และใบนัด)<input value={s.clinic_address} onChange={(e) => set({ clinic_address: e.target.value })} /></label>
      </div>
      <label className="raw small" style={{ marginLeft: 0 }}>
        <input type="checkbox" checked={s.send_purpose_in_message} onChange={(e) => set({ send_purpose_in_message: e.target.checked })} />
        ใส่เหตุผลนัดในข้อความ (แชทลับจะไม่ใส่เสมอ)
      </label>
      <p className="muted small">ตัวแปร: {TEMPLATE_VARIABLES.join(" ")} — {"{time}"} = "มาได้ช่วง 08.00–12.00 น. (ตรวจตามลำดับคิว)" หรือ "เวลา 09.30 น." · การปฏิบัติตัวต่อท้ายข้อความให้เสมอ · ไม่ผ่าน AI</p>
      <label>ข้อความภาษาไทย<textarea rows={5} value={s.template_th} onChange={(e) => set({ template_th: e.target.value })} /></label>
      <label>ข้อความภาษาอังกฤษ (แชทที่คุยภาษาอังกฤษ)<textarea rows={5} value={s.template_en} onChange={(e) => set({ template_en: e.target.value })} /></label>
      <div className="row">
        <button className="btn primary" onClick={save}>บันทึกการตั้งค่านัดหมาย</button>
        <span className="small">{saved}</span>
      </div>

      <PurposePresets />
      <ClinicHoursSettings />

      <h3 style={{ marginTop: 16 }}>ส่งทดสอบหาตัวเอง</h3>
      <p className="muted small">ทักแชท LINE ของคลินิกจากบัญชีตัวเองก่อน แล้วค้นชื่อแชทนั้น (Facebook/Instagram ต้องทักภายใน 24 ชม.)</p>
      <div className="row">
        <input style={{ flex: 1, width: "auto" }} placeholder="ค้นชื่อแชทของคุณ" value={chatQuery} onChange={(e) => setChatQuery(e.target.value)} />
        <select style={{ flex: 1, width: "auto" }} value={testChat} onChange={(e) => setTestChat(e.target.value)} aria-label="แชทที่จะส่งทดสอบ">
          <option value="">เลือกแชท</option>
          {chats.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.channel})</option>)}
        </select>
        <button className="btn ghost" disabled={!testChat} onClick={sendTest}>ส่งทดสอบ</button>
      </div>
      {testResult && <div className="small">{testResult}</div>}

      <h3 style={{ marginTop: 16 }}>โควตา LINE เดือนนี้</h3>
      {quota ? (
        <div className="small">
          ใช้ไป <b>{quota.used.toLocaleString("th-TH")}</b>
          {quota.limit != null ? <> / {quota.limit.toLocaleString("th-TH")} ข้อความ (เหลือ {(quota.limit - quota.used).toLocaleString("th-TH")})</> : " ข้อความ (ไม่จำกัด)"}
        </div>
      ) : <div className="muted small">{quotaErr || "กำลังโหลด…"}</div>}
    </section>
  );
}
