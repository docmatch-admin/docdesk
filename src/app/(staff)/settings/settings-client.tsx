"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BOOKING_TEMPLATE_LABEL, DEFAULT_BOOKING_TEMPLATES, normalizeBookingTemplates, type BookingTemplates } from "@/lib/booking-rules";
import { AUTO_CLOSE_EXEMPT_TAGS, DEFAULT_AUTO_CLOSE_HOURS, normalizeAutoCloseHours } from "@/lib/case-flow";
import { DEFAULT_SCORE_RULES, normalizeScoreRules, type ScoreRules } from "@/lib/scoring";
import { DEFAULT_SENSITIVE_KEYWORDS, DEFAULT_SENSITIVE_RETENTION_DAYS, normalizeSensitiveKeywords } from "@/lib/sensitive-rules";
import { bangkokDate, summarizeUsage, USD_TO_THB, type LlmUsageRow } from "@/lib/llm-usage";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { AppointmentSettings } from "./appointment-settings";
import { HealthPanel } from "./health-panel";
import { AiModelsPanel } from "./ai-models-panel";
import { LineUsagePanel, type Usage } from "./line-usage-panel";
import { PriceAlerts } from "./price-alerts";
import { CardHead, SettingsContext, type SaveUnit, type SettingsCtx, type SettingsTab } from "./settings-save";
import { TagSettings } from "./tag-settings";
import { AI_MODE_HINT, AI_MODE_LABEL, CHANNEL_LABEL, type AiMode, type ChannelType } from "@/lib/types";

interface Channel { id: string; type: ChannelType; name: string; ai_mode: AiMode | null; enabled: boolean }
interface Hours { tz: string; days: Record<string, [string, string] | null> }

const DAY = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
/** จันทร์ก่อน อาทิตย์ท้ายสุด */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MODES = Object.keys(AI_MODE_LABEL) as AiMode[];

export const TABS: [SettingsTab, string][] = [
  ["overview", "ภาพรวม"], ["ai", "AI"], ["chat", "แชทและแท็ก"], ["appointments", "นัดหมายและข้อความ"], ["team", "ทีมและระบบ"],
];
const isTab = (v: unknown): v is SettingsTab => TABS.some(([k]) => k === v);

/** ค่าที่การ์ดของหน้านี้แก้ (บันทึกพร้อมกันใน settings) แยกตามการ์ดเพื่อบอกว่าการ์ดไหนยังไม่บันทึก */
const CORE_CARDS: Record<string, { label: string; tab: SettingsTab; keys: string[] }> = {
  mode: { label: "โหมด AI ทั้งระบบ", tab: "ai", keys: ["mode", "minutes"] },
  channels: { label: "รายช่องทาง", tab: "ai", keys: ["channels"] },
  persona: { label: "บุคลิกการตอบของ AI", tab: "ai", keys: ["profile"] },
  hours: { label: "เวลาทำการ", tab: "chat", keys: ["hours"] },
  autoclose: { label: "ย้ายไปเสร็จแล้วอัตโนมัติ", tab: "chat", keys: ["autoCloseHours"] },
  sensitive: { label: "แชทลับ", tab: "chat", keys: ["sensitiveKeywords", "sensitiveDays"] },
  booking: { label: "ข้อความการจอง", tab: "appointments", keys: ["bookingTemplates"] },
  score: { label: "เกณฑ์คะแนนเจ้าหน้าที่", tab: "team", keys: ["scoreRules"] },
  retention: { label: "การเก็บรูปภาพ", tab: "team", keys: ["retentionDays"] },
};

/** preview: ข้อมูลตั้งต้นสำหรับภาพตัวอย่าง/เทสต์ (หน้าใช้งานจริงไม่ส่ง โหลดจากฐานข้อมูลเสมอ) */
export interface SettingsPreview {
  tab?: SettingsTab;
  health?: Parameters<typeof HealthPanel>[0] extends infer P ? P extends { initial?: infer H } ? H : never : never;
  usage?: Usage;
  models?: Parameters<typeof AiModelsPanel>[0] extends infer P ? P extends { initial?: infer M } ? M : never : never;
  appointments?: Parameters<typeof AppointmentSettings>[0] extends infer P ? P extends { initial?: infer A } ? A : never : never;
  channels?: Channel[];
  hours?: Hours;
}

export function SettingsClient({ preview }: { preview?: SettingsPreview } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [tab, setTab] = useState<SettingsTab>(preview?.tab ?? "overview");
  const [mode, setMode] = useState<AiMode>("assist");
  const [minutes, setMinutes] = useState(5);
  const [hours, setHours] = useState<Hours>(preview?.hours ?? { tz: "Asia/Bangkok", days: {} });
  const [profile, setProfile] = useState({ name: "", tone: "" });
  const [channels, setChannels] = useState<Channel[]>(preview?.channels ?? []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [usage, setUsage] = useState<LlmUsageRow[]>([]);
  const [scoreRules, setScoreRules] = useState<ScoreRules>(DEFAULT_SCORE_RULES);
  const [retentionDays, setRetentionDays] = useState(90);
  const [autoCloseHours, setAutoCloseHours] = useState(DEFAULT_AUTO_CLOSE_HOURS);
  const [sensitiveKeywords, setSensitiveKeywords] = useState(DEFAULT_SENSITIVE_KEYWORDS.join("\n"));
  const [sensitiveDays, setSensitiveDays] = useState(DEFAULT_SENSITIVE_RETENTION_DAYS);
  const [bookingTemplates, setBookingTemplates] = useState<BookingTemplates>(DEFAULT_BOOKING_TEMPLATES);
  // ค่าที่บันทึกล่าสุดต่อคีย์ (JSON) เทียบกับค่าปัจจุบัน → การ์ดไหนยังไม่บันทึก
  const [baseline, setBaseline] = useState<Record<string, string> | null>(null);

  // การ์ดอื่นที่มีข้อมูลของตัวเอง (นัดหมาย เวลาเปิดคลินิก โมเดล AI) ลงทะเบียนกับปุ่มบันทึกรวม
  const [units, setUnits] = useState<Record<string, { unit: SaveUnit; dirty: boolean }>>({});
  const [alerts, setAlerts] = useState<Record<string, { tab: SettingsTab; on: boolean }>>({});
  const ctx = useMemo<SettingsCtx>(() => ({
    setUnit: (unit, dirty) => setUnits((cur) => (cur[unit.id]?.dirty === dirty && cur[unit.id]?.unit.label === unit.label ? { ...cur, [unit.id]: { unit, dirty } } : { ...cur, [unit.id]: { unit, dirty } })),
    removeUnit: (id) => setUnits((cur) => { const next = { ...cur }; delete next[id]; return next; }),
    setAlert: (key, t, on) => setAlerts((cur) => (cur[key]?.on === on ? cur : { ...cur, [key]: { tab: t, on } })),
  }), []);

  // แท็บที่เลือกจำใน URL (?tab=)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("tab");
    if (isTab(q)) setTab(q);
  }, []);
  const pickTab = useCallback((t: SettingsTab) => {
    setTab(t);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", t);
    window.history.replaceState(null, "", url);
  }, []);

  useEffect(() => {
    sb.from("llm_usage_daily").select("*").gte("day", `${bangkokDate().slice(0, 7)}-01`)
      .then(({ data }) => setUsage((data ?? []) as LlmUsageRow[]));
    Promise.all([
      sb.from("settings").select("key, value"),
      sb.from("channels").select("id, type, name, ai_mode, enabled").order("created_at"),
    ]).then(([{ data }, { data: ch }]) => {
      const v = {
        mode: "assist" as AiMode, minutes: 5, hours: { tz: "Asia/Bangkok", days: {} } as Hours, profile: { name: "", tone: "" },
        retentionDays: 90, scoreRules: DEFAULT_SCORE_RULES, autoCloseHours: DEFAULT_AUTO_CLOSE_HOURS, bookingTemplates: DEFAULT_BOOKING_TEMPLATES,
        sensitiveKeywords: DEFAULT_SENSITIVE_KEYWORDS.join("\n"), sensitiveDays: DEFAULT_SENSITIVE_RETENTION_DAYS,
        channels: (ch ?? []) as Channel[],
      };
      for (const r of data ?? []) {
        if (r.key === "ai_mode") v.mode = r.value as AiMode;
        if (r.key === "fallback_minutes") v.minutes = Number(r.value);
        if (r.key === "business_hours") v.hours = r.value as Hours;
        if (r.key === "clinic_profile") v.profile = r.value as { name: string; tone: string };
        if (r.key === "media_retention_days") v.retentionDays = Number(r.value);
        if (r.key === "score_rules") v.scoreRules = normalizeScoreRules(r.value);
        if (r.key === "auto_close_hours") v.autoCloseHours = normalizeAutoCloseHours(r.value);
        if (r.key === "booking_templates") v.bookingTemplates = normalizeBookingTemplates(r.value);
        if (r.key === "sensitive_keywords") v.sensitiveKeywords = normalizeSensitiveKeywords(r.value).join("\n");
        if (r.key === "sensitive_media_retention_days") v.sensitiveDays = Number(r.value);
      }
      setMode(v.mode); setMinutes(v.minutes); setHours(v.hours); setProfile(v.profile); setRetentionDays(v.retentionDays);
      setScoreRules(v.scoreRules); setAutoCloseHours(v.autoCloseHours); setBookingTemplates(v.bookingTemplates);
      setSensitiveKeywords(v.sensitiveKeywords); setSensitiveDays(v.sensitiveDays); setChannels(v.channels);
      setBaseline(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, JSON.stringify(x)])));
    });
  }, [sb]);

  const values: Record<string, unknown> = { mode, minutes, hours, profile, retentionDays, scoreRules, autoCloseHours, bookingTemplates, sensitiveKeywords, sensitiveDays, channels };
  const keyDirty = (k: string) => baseline !== null && baseline[k] !== JSON.stringify(values[k]);
  const cardDirty = (id: keyof typeof CORE_CARDS) => CORE_CARDS[id].keys.some(keyDirty);
  const coreDirty = Object.keys(CORE_CARDS).some((id) => cardDirty(id));
  const dirtyUnits = Object.values(units).filter((u) => u.dirty);
  const dirtyLabels = [...Object.keys(CORE_CARDS).filter((id) => cardDirty(id)).map((id) => CORE_CARDS[id].label), ...dirtyUnits.map((u) => u.unit.label)];
  const dirty = dirtyLabels.length > 0;

  async function saveCore(): Promise<string | null> {
    const now = new Date().toISOString();
    const { error } = await sb.from("settings").upsert([
      { key: "ai_mode", value: mode, updated_at: now },
      { key: "fallback_minutes", value: minutes, updated_at: now },
      { key: "business_hours", value: hours, updated_at: now },
      { key: "clinic_profile", value: profile, updated_at: now },
      { key: "media_retention_days", value: Math.max(1, Math.floor(retentionDays) || 90), updated_at: now },
      { key: "auto_close_hours", value: normalizeAutoCloseHours(autoCloseHours), updated_at: now },
      { key: "score_rules", value: normalizeScoreRules(scoreRules), updated_at: now },
      { key: "booking_templates", value: normalizeBookingTemplates(bookingTemplates), updated_at: now },
      { key: "sensitive_keywords", value: normalizeSensitiveKeywords(sensitiveKeywords.split("\n")), updated_at: now },
      { key: "sensitive_media_retention_days", value: Math.max(1, Math.floor(sensitiveDays) || DEFAULT_SENSITIVE_RETENTION_DAYS), updated_at: now },
    ]);
    if (error) return error.message;
    if (keyDirty("channels")) {
      for (const c of channels) {
        const r = await sb.from("channels").update({ ai_mode: c.ai_mode, enabled: c.enabled }).eq("id", c.id);
        if (r.error) return r.error.message;
      }
    }
    setBaseline(Object.fromEntries(Object.entries(values).map(([k, x]) => [k, JSON.stringify(x)])));
    return null;
  }

  /** ปุ่มเดียวบันทึกทุกการ์ดที่มีการแก้ไข */
  async function saveAll() {
    setSaving(true);
    const errors: string[] = [];
    if (coreDirty) {
      const e = await saveCore();
      if (e) errors.push(`ตั้งค่าทั่วไป: ${e}`);
    }
    for (const { unit } of dirtyUnits) {
      const e = await unit.save();
      if (e) errors.push(`${unit.label}: ${e}`);
    }
    setSaving(false);
    setSaved(errors.length ? `บันทึกไม่สำเร็จ — ${errors.join(" · ")}` : "บันทึกแล้ว ✓");
    if (!errors.length) setTimeout(() => setSaved(""), 3000);
  }

  // ออกจากหน้าโดยยังไม่บันทึก: เตือนก่อน
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const tabDirty = (t: SettingsTab) => Object.entries(CORE_CARDS).some(([id, c]) => c.tab === t && cardDirty(id)) || dirtyUnits.some((u) => u.unit.tab === t);
  const tabAlert = (t: SettingsTab) => Object.values(alerts).some((a) => a.tab === t && a.on);
  const setDay = (d: number, v: [string, string] | null) => setHours({ ...hours, days: { ...hours.days, [d]: v } });
  const stats = summarizeUsage(usage);
  const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const panel = (t: SettingsTab, children: React.ReactNode) => (
    <div className="settings-panel" role="tabpanel" id={`tab-${t}`} aria-labelledby={`tabbtn-${t}`} hidden={tab !== t}>{children}</div>
  );

  return (
    <SettingsContext.Provider value={ctx}>
      <div className="page settings-page">
        <div className="settings-top">
          <h1>ตั้งค่า AI</h1>
          <div className="settings-tabs" role="tablist" aria-label="หมวดการตั้งค่า">
            {TABS.map(([k, label]) => (
              <button key={k} id={`tabbtn-${k}`} type="button" role="tab" aria-selected={tab === k} aria-controls={`tab-${k}`}
                className={tab === k ? "on" : ""} onClick={() => pickTab(k)}>
                {label}
                {tabAlert(k) && <i className="tab-dot red" aria-label="มีสิ่งผิดปกติ" />}
                {tabDirty(k) && <i className="tab-dot yellow" aria-label="มีการแก้ไขที่ยังไม่บันทึก" />}
              </button>
            ))}
          </div>
        </div>

        {panel("overview", (
          <div className="settings-masonry">
            <HealthPanel initial={preview?.health} />
            <LineUsagePanel initial={preview?.usage} />
            <section className="card">
              <CardHead title="การใช้ AI" info={`ค่าใช้จ่ายโดยประมาณ รวม embedding คิดที่ 1 USD = ${USD_TO_THB} บาท ยอดจริงดูที่หน้า billing ของ OpenAI${stats.unpricedModels.length ? ` · ไม่รวมโมเดลที่ไม่รู้ราคา: ${stats.unpricedModels.join(", ")}` : ""}`} />
              <div className="row between ch-row"><span>เรียก LLM วันนี้</span><b>{stats.todayCalls.toLocaleString("th-TH")} ครั้ง · ~{baht(stats.todayCostThb)} บาท</b></div>
              <div className="row between ch-row"><span>เรียก LLM เดือนนี้</span><b>{stats.monthCalls.toLocaleString("th-TH")} ครั้ง · ~{baht(stats.monthCostThb)} บาท</b></div>
            </section>
            <PriceAlerts />
          </div>
        ))}

        {panel("ai", (
          <div className="settings-masonry">
            <AiModelsPanel initial={preview?.models} />
            <section className="card">
              <CardHead title="โหมด AI ทั้งระบบ" dirty={cardDirty("mode")} info="ตั้งแยกรายช่องทางและรายแชท (ในหน้าแชท) ได้ — รายแชทสำคัญที่สุด" />
              <div className="mode-cards">
                {MODES.map((m) => (
                  <button key={m} className={`mode-card ${mode === m ? "on" : ""}`} onClick={() => setMode(m)}>
                    <b>{AI_MODE_LABEL[m]}</b>
                    <span className="small">{AI_MODE_HINT[m]}</span>
                  </button>
                ))}
              </div>
              <label className="inline">
                โหมด “คนตอบก่อน”: AI ตอบแทนเมื่อไม่มีใครตอบภายใน
                <input type="number" min={1} max={120} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /> นาที
              </label>
            </section>
            <section className="card">
              <CardHead title="บุคลิกการตอบของ AI" dirty={cardDirty("persona")} />
              <label>ชื่อคลินิก<input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></label>
              <label>โทน/สำนวน<textarea rows={3} value={profile.tone} onChange={(e) => setProfile({ ...profile, tone: e.target.value })} /></label>
            </section>
            <section className="card">
              <CardHead title="รายช่องทาง" dirty={cardDirty("channels")} info="โหมด AI ของแต่ละช่องทาง ว่าง = ตามโหมดทั้งระบบ" />
              {channels.map((c, i) => (
                <div key={c.id} className="row between ch-row">
                  <div><span className={`chip ch-${c.type}`}>{CHANNEL_LABEL[c.type]}</span> {c.name}</div>
                  <div className="row">
                    <select value={c.ai_mode ?? ""} aria-label={`โหมด AI ของ ${c.name}`} onChange={(e) => {
                      const next = [...channels]; next[i] = { ...c, ai_mode: (e.target.value || null) as AiMode | null }; setChannels(next);
                    }}>
                      <option value="">ตามทั้งระบบ</option>
                      {MODES.map((m) => <option key={m} value={m}>{AI_MODE_LABEL[m]}</option>)}
                    </select>
                    <label className="raw">
                      <input type="checkbox" checked={c.enabled} onChange={(e) => {
                        const next = [...channels]; next[i] = { ...c, enabled: e.target.checked }; setChannels(next);
                      }} /> เปิดใช้
                    </label>
                  </div>
                </div>
              ))}
            </section>
          </div>
        ))}

        {panel("chat", (
          <div className="settings-masonry">
            <section className="card">
              <CardHead title="เวลาทำการ" dirty={cardDirty("hours")} info="นอกเวลาทำการ โหมด “คนตอบก่อน” จะให้ AI ตอบทันที" />
              <div className="business-hours">
                {DAY_ORDER.map((d) => {
                  const r = hours.days[d];
                  return (
                    <div key={d} className="business-hours-row">
                      <label className="raw"><input type="checkbox" checked={!!r} onChange={(e) => setDay(d, e.target.checked ? ["08:00", "18:00"] : null)} /> {DAY[d]}</label>
                      {r ? (
                        <span className="business-hours-times">
                          <input type="time" aria-label={`${DAY[d]} เปิด`} value={r[0]} onChange={(e) => setDay(d, [e.target.value, r[1]])} />–
                          <input type="time" aria-label={`${DAY[d]} ปิด`} value={r[1]} onChange={(e) => setDay(d, [r[0], e.target.value])} />
                        </span>
                      ) : <span className="muted small">ปิด</span>}
                    </div>
                  );
                })}
              </div>
              <p className="set-other-note">ใช้กับ AI ตอบแชทเท่านั้น — ช่วงเวลาให้คนไข้เลือกตอนนัดตั้งแยกที่ “เวลาเปิดคลินิก” (แท็บนัดหมายและข้อความ) เป็นข้อมูลคนละชุด</p>
            </section>
            <section className="card">
              <CardHead title="ย้ายไปเสร็จแล้วอัตโนมัติ" dirty={cardDirty("autoclose")} info={`ใส่ 0 เพื่อปิด ไม่ย้ายแชทที่มีแท็ก ${AUTO_CLOSE_EXEMPT_TAGS.join(" หรือ ")} หรือป้าย “ต้องให้คนตอบ” ลูกค้าทักกลับมาแชทจะเปิดเอง`} />
              <label className="inline">
                เมื่อเราตอบล่าสุดและลูกค้าเงียบเกิน
                <input type="number" min={0} max={8760} value={autoCloseHours} onChange={(e) => setAutoCloseHours(Number(e.target.value))} /> ชั่วโมง
              </label>
            </section>
            <section className="card">
              <CardHead title="แชทลับ" dirty={cardDirty("sensitive")} info="ข้อความลูกค้าที่มีคำเหล่านี้จะถูกตั้งเป็นแชทลับ ติดแล้วไม่หายเอง เอาออกได้เฉพาะ admin ในห้องแชท" />
              <label>คำสำคัญ บรรทัดละคำ
                <textarea rows={6} value={sensitiveKeywords} onChange={(e) => setSensitiveKeywords(e.target.value)} />
              </label>
              <label className="inline">ลบรูปในแชทลับหลัง
                <input type="number" min={1} value={sensitiveDays} onChange={(e) => setSensitiveDays(Number(e.target.value))} /> วัน
              </label>
            </section>
            <TagSettings />
          </div>
        ))}

        {panel("appointments", (
          <div className="settings-masonry">
            <AppointmentSettings initial={preview?.appointments} />
            <section className="card set-wide">
              <CardHead title="ข้อความการจอง" dirty={cardDirty("booking")} info="ระบบแทนค่าในวงเล็บปีกกาให้ และแปลตามภาษาลูกค้าตอนส่ง เว้นว่างแล้วบันทึกจะกลับเป็นค่าเริ่มต้น" />
              <div className="set-wide-grid">
                {(Object.keys(BOOKING_TEMPLATE_LABEL) as (keyof BookingTemplates)[]).map((key) => (
                  <label key={key}>{BOOKING_TEMPLATE_LABEL[key]}
                    <textarea rows={2} value={bookingTemplates[key]} onChange={(e) => setBookingTemplates({ ...bookingTemplates, [key]: e.target.value })} />
                  </label>
                ))}
              </div>
            </section>
          </div>
        ))}

        {panel("team", (
          <div className="settings-masonry">
            <section className="card">
              <CardHead title="เกณฑ์คะแนนเจ้าหน้าที่" dirty={cardDirty("score")} info="นับเวลาเฉพาะเวลาทำการ ตอบช้ากว่าขั้นสุดท้ายได้ 0 คะแนน" />
              {scoreRules.speed.map((tier, i) => (
                <label key={i} className="inline">
                  ตอบภายใน
                  <input type="number" min={0} value={tier.maxSeconds / 60} aria-label={`นาทีของขั้นที่ ${i + 1}`} onChange={(e) => {
                    const speed = [...scoreRules.speed];
                    speed[i] = { ...tier, maxSeconds: Number(e.target.value) * 60 };
                    setScoreRules({ ...scoreRules, speed });
                  }} /> นาที ได้
                  <input type="number" min={0} step={0.5} value={tier.points} aria-label={`คะแนนของขั้นที่ ${i + 1}`} onChange={(e) => {
                    const speed = [...scoreRules.speed];
                    speed[i] = { ...tier, points: Number(e.target.value) };
                    setScoreRules({ ...scoreRules, speed });
                  }} /> คะแนน
                </label>
              ))}
              <label className="inline">คำตอบสั้นกว่า
                <input type="number" min={0} value={scoreRules.shortChars} onChange={(e) => setScoreRules({ ...scoreRules, shortChars: Number(e.target.value) })} /> ตัวอักษร ได้ครึ่งเดียว
              </label>
              <label className="inline">ข้อความถูกกดดาว ได้
                <input type="number" min={0} step={0.5} value={scoreRules.starPoints} onChange={(e) => setScoreRules({ ...scoreRules, starPoints: Number(e.target.value) })} /> คะแนน
              </label>
              <label className="inline">กดเสร็จแล้ว คนที่ตอบล่าสุดได้
                <input type="number" min={0} step={0.5} value={scoreRules.closePoints} onChange={(e) => setScoreRules({ ...scoreRules, closePoints: Number(e.target.value) })} /> คะแนน
              </label>
            </section>
            <section className="card">
              <CardHead title="การเก็บรูปภาพ" dirty={cardDirty("retention")} info="ข้อความยังอยู่ แต่รูปจะขึ้นว่า “รูปถูกลบตามนโยบายเก็บข้อมูล” การลบกู้คืนไม่ได้ รูปที่ใช้บ่อยไม่ถูกลบ" />
              <label className="inline">
                ลบรูปในแชทอัตโนมัติเมื่อเก่ากว่า
                <input type="number" min={1} max={3650} value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))} /> วัน
              </label>
            </section>
          </div>
        ))}

        <div className={`settings-savebar ${dirty ? "dirty" : ""}`} role="region" aria-label="บันทึกการตั้งค่า">
          <button className="btn primary" onClick={saveAll} disabled={saving || baseline === null || !dirty}>{saving ? "กำลังบันทึก…" : "บันทึกการตั้งค่า"}</button>
          {dirty
            ? <span className="settings-dirty" title={dirtyLabels.join(", ")}>● มีการแก้ไขที่ยังไม่บันทึก: {dirtyLabels.join(", ")}</span>
            : <span className={saved.startsWith("บันทึกไม่สำเร็จ") ? "error small" : "muted small"}>{saved || "บันทึกแล้วทั้งหมด"}</span>}
          {dirty && saved.startsWith("บันทึกไม่สำเร็จ") && <span className="error small">{saved}</span>}
        </div>
      </div>
    </SettingsContext.Provider>
  );
}
