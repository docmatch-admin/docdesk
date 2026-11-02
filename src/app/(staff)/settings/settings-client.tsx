"use client";

import { useEffect, useMemo, useState } from "react";
import { BOOKING_TEMPLATE_LABEL, DEFAULT_BOOKING_TEMPLATES, normalizeBookingTemplates, type BookingTemplates } from "@/lib/booking-rules";
import { AUTO_CLOSE_EXEMPT_TAGS, DEFAULT_AUTO_CLOSE_HOURS, normalizeAutoCloseHours } from "@/lib/case-flow";
import { DEFAULT_SCORE_RULES, normalizeScoreRules, type ScoreRules } from "@/lib/scoring";
import { DEFAULT_SENSITIVE_KEYWORDS, DEFAULT_SENSITIVE_RETENTION_DAYS, normalizeSensitiveKeywords } from "@/lib/sensitive-rules";
import { bangkokDate, summarizeUsage, USD_TO_THB, type LlmUsageRow } from "@/lib/llm-usage";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { HealthPanel } from "./health-panel";
import { TagSettings } from "./tag-settings";
import { AI_MODE_HINT, AI_MODE_LABEL, CHANNEL_LABEL, type AiMode, type ChannelType } from "@/lib/types";

interface Channel { id: string; type: ChannelType; name: string; ai_mode: AiMode | null; enabled: boolean }
interface Hours { tz: string; days: Record<string, [string, string] | null> }

const DAY = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const MODES = Object.keys(AI_MODE_LABEL) as AiMode[];

export function SettingsClient() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [mode, setMode] = useState<AiMode>("assist");
  const [minutes, setMinutes] = useState(5);
  const [hours, setHours] = useState<Hours>({ tz: "Asia/Bangkok", days: {} });
  const [profile, setProfile] = useState({ name: "", tone: "" });
  const [channels, setChannels] = useState<Channel[]>([]);
  const [saved, setSaved] = useState("");
  const [usage, setUsage] = useState<LlmUsageRow[]>([]);
  const [scoreRules, setScoreRules] = useState<ScoreRules>(DEFAULT_SCORE_RULES);
  const [retentionDays, setRetentionDays] = useState(90);
  const [autoCloseHours, setAutoCloseHours] = useState(DEFAULT_AUTO_CLOSE_HOURS);
  const [sensitiveKeywords, setSensitiveKeywords] = useState(DEFAULT_SENSITIVE_KEYWORDS.join("\n"));
  const [sensitiveDays, setSensitiveDays] = useState(DEFAULT_SENSITIVE_RETENTION_DAYS);
  const [bookingTemplates, setBookingTemplates] = useState<BookingTemplates>(DEFAULT_BOOKING_TEMPLATES);

  useEffect(() => {
    sb.from("llm_usage_daily").select("*").gte("day", `${bangkokDate().slice(0, 7)}-01`)
      .then(({ data }) => setUsage((data ?? []) as LlmUsageRow[]));
    sb.from("settings").select("key, value").then(({ data }) => {
      for (const r of data ?? []) {
        if (r.key === "ai_mode") setMode(r.value as AiMode);
        if (r.key === "fallback_minutes") setMinutes(Number(r.value));
        if (r.key === "business_hours") setHours(r.value as Hours);
        if (r.key === "clinic_profile") setProfile(r.value as { name: string; tone: string });
        if (r.key === "media_retention_days") setRetentionDays(Number(r.value));
        if (r.key === "score_rules") setScoreRules(normalizeScoreRules(r.value));
        if (r.key === "auto_close_hours") setAutoCloseHours(normalizeAutoCloseHours(r.value));
        if (r.key === "booking_templates") setBookingTemplates(normalizeBookingTemplates(r.value));
        if (r.key === "sensitive_keywords") setSensitiveKeywords(normalizeSensitiveKeywords(r.value).join("\n"));
        if (r.key === "sensitive_media_retention_days") setSensitiveDays(Number(r.value));
      }
    });
    sb.from("channels").select("id, type, name, ai_mode, enabled").order("created_at")
      .then(({ data }) => setChannels((data ?? []) as Channel[]));
  }, [sb]);

  async function saveAll() {
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
    for (const c of channels) {
      await sb.from("channels").update({ ai_mode: c.ai_mode, enabled: c.enabled }).eq("id", c.id);
    }
    setSaved(error ? "บันทึกไม่สำเร็จ: " + error.message : "บันทึกแล้ว ✓");
    setTimeout(() => setSaved(""), 3000);
  }

  const setDay = (d: number, v: [string, string] | null) => setHours({ ...hours, days: { ...hours.days, [d]: v } });
  const stats = summarizeUsage(usage);
  const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="page narrow">
      <h1>ตั้งค่า AI</h1>

      <HealthPanel />

      <section className="card">
        <h3>โหมด AI ทั้งระบบ</h3>
        <p className="muted small">ตั้งแยกรายช่องทาง (ด้านล่าง) และรายแชท (ในหน้าแชท) ได้ — รายแชทสำคัญที่สุด</p>
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
        <h3>รายช่องทาง</h3>
        {channels.map((c, i) => (
          <div key={c.id} className="row between ch-row">
            <div><span className={`chip ch-${c.type}`}>{CHANNEL_LABEL[c.type]}</span> {c.name}</div>
            <div className="row">
              <select value={c.ai_mode ?? ""} onChange={(e) => {
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

      <section className="card">
        <h3>เวลาทำการ</h3>
        <p className="muted small">นอกเวลาทำการ โหมด “คนตอบก่อน” จะให้ AI ตอบทันที</p>
        {DAY.map((name, d) => {
          const r = hours.days[d];
          return (
            <div key={d} className="row hours-row">
              <label className="raw" style={{ width: 120 }}>
                <input type="checkbox" checked={!!r} onChange={(e) => setDay(d, e.target.checked ? ["08:00", "18:00"] : null)} /> {name}
              </label>
              {r ? (
                <>
                  <input type="time" value={r[0]} onChange={(e) => setDay(d, [e.target.value, r[1]])} />–
                  <input type="time" value={r[1]} onChange={(e) => setDay(d, [r[0], e.target.value])} />
                </>
              ) : <span className="muted small">ปิด</span>}
            </div>
          );
        })}
      </section>

      <section className="card">
        <h3>บุคลิกการตอบของ AI</h3>
        <label>ชื่อคลินิก<input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></label>
        <label>โทน/สำนวน<textarea rows={3} value={profile.tone} onChange={(e) => setProfile({ ...profile, tone: e.target.value })} /></label>
      </section>

      <section className="card">
        <h3>🔒 แชทลับ</h3>
        <p className="muted small">ข้อความลูกค้าที่มีคำเหล่านี้จะถูกตั้งเป็นแชทลับ ติดแล้วไม่หายเอง เอาออกได้เฉพาะ admin ในห้องแชท</p>
        <label>คำสำคัญ บรรทัดละคำ
          <textarea rows={8} value={sensitiveKeywords} onChange={(e) => setSensitiveKeywords(e.target.value)} />
        </label>
        <label className="inline">ลบรูปในแชทลับหลัง
          <input type="number" min={1} value={sensitiveDays} onChange={(e) => setSensitiveDays(Number(e.target.value))} /> วัน
        </label>
      </section>

      <section className="card">
        <h3>ข้อความการจอง</h3>
        <p className="muted small">ระบบแทนค่าในวงเล็บปีกกาให้ และแปลตามภาษาลูกค้าตอนส่ง เว้นว่างแล้วบันทึกจะกลับเป็นค่าเริ่มต้น</p>
        {(Object.keys(BOOKING_TEMPLATE_LABEL) as (keyof BookingTemplates)[]).map((key) => (
          <label key={key}>{BOOKING_TEMPLATE_LABEL[key]}
            <textarea rows={2} value={bookingTemplates[key]} onChange={(e) => setBookingTemplates({ ...bookingTemplates, [key]: e.target.value })} />
          </label>
        ))}
      </section>

      <section className="card">
        <h3>เกณฑ์คะแนนเจ้าหน้าที่</h3>
        <p className="muted small">นับเวลาเฉพาะเวลาทำการ ตอบช้ากว่าขั้นสุดท้ายได้ 0 คะแนน</p>
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
        <h3>ย้ายไปเสร็จแล้วอัตโนมัติ</h3>
        <label className="inline">
          เมื่อเราตอบล่าสุดและลูกค้าเงียบเกิน
          <input type="number" min={0} max={8760} value={autoCloseHours} onChange={(e) => setAutoCloseHours(Number(e.target.value))} /> ชั่วโมง
        </label>
        <p className="muted small">ใส่ 0 เพื่อปิด ไม่ย้ายแชทที่มีแท็ก {AUTO_CLOSE_EXEMPT_TAGS.join(" หรือ ")} หรือป้าย “ต้องให้คนตอบ” ลูกค้าทักกลับมาแชทจะเปิดเอง</p>
      </section>

      <section className="card">
        <h3>การเก็บรูปภาพ</h3>
        <label className="inline">
          ลบรูปในแชทอัตโนมัติเมื่อเก่ากว่า
          <input type="number" min={1} max={3650} value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))} /> วัน
        </label>
        <p className="muted small">ข้อความยังอยู่ แต่รูปจะขึ้นว่า “รูปถูกลบตามนโยบายเก็บข้อมูล” การลบกู้คืนไม่ได้ รูปที่ใช้บ่อยไม่ถูกลบ</p>
      </section>

      <section className="card">
        <h3>การใช้ AI</h3>
        <div className="row between ch-row"><span>เรียก LLM วันนี้</span><b>{stats.todayCalls.toLocaleString("th-TH")} ครั้ง · ~{baht(stats.todayCostThb)} บาท</b></div>
        <div className="row between ch-row"><span>เรียก LLM เดือนนี้</span><b>{stats.monthCalls.toLocaleString("th-TH")} ครั้ง · ~{baht(stats.monthCostThb)} บาท</b></div>
        <p className="muted small">
          ค่าใช้จ่ายโดยประมาณ รวม embedding คิดที่ 1 USD = {USD_TO_THB} บาท ยอดจริงดูที่หน้า billing ของ OpenAI
          {stats.unpricedModels.length > 0 && <> · ไม่รวมโมเดลที่ไม่รู้ราคา: {stats.unpricedModels.join(", ")}</>}
        </p>
      </section>

      <TagSettings />

      <div className="row sticky-save">
        <button className="btn primary" onClick={saveAll}>บันทึกการตั้งค่า</button>
        <span className="muted">{saved}</span>
      </div>
    </div>
  );
}
