// ไคลเอนต์ iService (HIS) ใช้ใน Edge Function เท่านั้น รหัสผ่านอยู่ใน Supabase secrets ไม่ถึงเบราว์เซอร์
// secrets: ISERVICE_USERNAME, ISERVICE_PASSWORD, ISERVICE_CIS_CODE
//
// หมายเหตุ: รูปแบบคำตอบของ ovst_list และ patient_list ยังไม่ได้ยืนยันกับระบบจริง
// จึงอ่านแบบยืดหยุ่น (หา array แรกในคำตอบ และลองชื่อ field หลายแบบ) ตรวจกับข้อมูลจริงก่อนใช้งาน

const BASE = "https://iservice.ehp.co.th";
const TOKEN_TTL_MS = 20 * 60_000;

let cached: { token: string; at: number } | null = null;

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`ยังไม่ได้ตั้ง secret ${name}`);
  return v;
}

export const cisCode = () => env("ISERVICE_CIS_CODE");

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: env("ISERVICE_USERNAME"), password: env("ISERVICE_PASSWORD"), ip: "0.0.0.0" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`iService login ${res.status}`);
  const j = await res.json() as Record<string, unknown>;
  const data = (j.data ?? {}) as Record<string, unknown>;
  const token = (j.local_token ?? data.local_token ?? j.token ?? data.token) as string | undefined;
  if (!token) throw new Error("iService login: ไม่มี local_token ในคำตอบ");
  cached = { token, at: Date.now() };
  return token;
}

/** GET พร้อม token ถ้า token หมดอายุ (401) login ใหม่หนึ่งครั้ง */
export async function iserviceGet(path: string, params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams({ cis_code: cisCode(), ...params }).toString();
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = cached && Date.now() - cached.at < TOKEN_TTL_MS && attempt === 0 ? cached.token : await login();
    const res = await fetch(`${BASE}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 && attempt === 0) { cached = null; continue; }
    if (!res.ok) throw new Error(`iService ${path} ${res.status}`);
    return res.json();
  }
  throw new Error(`iService ${path}: login ไม่สำเร็จ`);
}

const hasHn = (o: Record<string, unknown>) => Object.keys(o).some((k) => k.toLowerCase() === "hn");

/**
 * รายการคนไข้ในคำตอบ: ทุก object ที่มี field hn ไม่ว่าจะซ้อนลึกแค่ไหน
 * รองรับ [] | {data: []} | {data: {days: [{times: [{appointments: []}]}]}}
 */
export function rowsOf(json: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v == null || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const o = v as Record<string, unknown>;
    if (hasHn(o)) { out.push(o); return; }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(json, 0);
  return out;
}

/** โครงสร้างคำตอบ (ชื่อ key และขนาด array เท่านั้น ไม่มีค่าข้อมูลคนไข้) */
function shapeOf(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return depth > 3 ? `array(${v.length})` : { array: v.length, first: v.length ? shapeOf(v[0], depth + 1) : null };
  if (v && typeof v === "object") {
    if (depth > 3) return "object";
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, x && typeof x === "object" ? shapeOf(x, depth + 1) : typeof x]));
  }
  return typeof v;
}

/** ตรวจการเชื่อม iService ทีละขั้น ไม่คืนค่าลับหรือข้อมูลคนไข้ */
export async function diagnose(date: string) {
  const secrets = Object.fromEntries(["ISERVICE_USERNAME", "ISERVICE_PASSWORD", "ISERVICE_CIS_CODE"].map((n) => [n, !!Deno.env.get(n)]));
  const out: Record<string, unknown> = { date, secrets };
  if (Object.values(secrets).some((v) => !v)) return out;
  try {
    const res = await fetch(`${BASE}/api/v1/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: env("ISERVICE_USERNAME"), password: env("ISERVICE_PASSWORD"), ip: "0.0.0.0" }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(text); } catch { /* ไม่ใช่ JSON */ }
    const data = (j.data ?? {}) as Record<string, unknown>;
    const tokenAt = j.local_token ? "local_token" : data.local_token ? "data.local_token" : j.token ? "token" : data.token ? "data.token" : null;
    out.login = { status: res.status, json: !!Object.keys(j).length, shape: shapeOf(j), tokenAt, message: typeof j.message === "string" ? j.message.slice(0, 200) : undefined };
    if (!tokenAt) return out;
    const token = (j.local_token ?? data.local_token ?? j.token ?? data.token) as string;
    const qs = new URLSearchParams({ cis_code: cisCode(), date_start: date, date_end: date }).toString();
    const r2 = await fetch(`${BASE}/api/ovst/v1/ovst_list?${qs}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const t2 = await r2.text();
    let j2: unknown = null;
    try { j2 = JSON.parse(t2); } catch { /* ไม่ใช่ JSON */ }
    const rows = rowsOf(j2);
    out.ovst_list = {
      status: r2.status, json: j2 !== null, shape: shapeOf(j2), rows: rows.length,
      rowKeys: rows[0] ? Object.keys(rows[0]) : [],
      parsed: rows.slice(0, 50).map(toVisit).filter((v) => v.hn).length,
      sampleHasName: rows[0] ? !!toVisit(rows[0]).name : null,
      sampleHasDoctor: rows[0] ? !!toVisit(rows[0]).doctor : null,
      sampleHasTime: rows[0] ? !!toVisit(rows[0]).time : null,
      message: j2 && typeof j2 === "object" && typeof (j2 as Record<string, unknown>).message === "string" ? ((j2 as Record<string, unknown>).message as string).slice(0, 200) : undefined,
    };
  } catch (e) {
    out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  return out;
}

const pick = (r: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) {
    const v = r[k] ?? r[k.toUpperCase()] ?? r[k.toLowerCase()];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
};

export interface Visit { hn: string; name: string; doctor: string; time: string; phone: string }
export interface Patient { hn: string; name: string; phone: string }

export function toVisit(r: Record<string, unknown>): Visit {
  return {
    hn: pick(r, ["hn"]),
    name: pick(r, ["pt_name", "patient", "patient_name", "NAMESS", "fullname", "full_name", "ptname", "name"]),
    doctor: pick(r, ["doctor", "doctor_name", "doctorname", "dr_name", "dname", "provider"]),
    time: pick(r, ["vsttime", "visit_time", "time", "vn_time", "regist_time", "created_at"]),
    phone: pick(r, ["mobile_phone_number", "phone", "mobile", "tel"]),
  };
}

export function toPatient(r: Record<string, unknown>): Patient {
  return {
    hn: pick(r, ["hn"]),
    name: pick(r, ["NAMESS", "pt_name", "patient", "patient_name", "fullname", "full_name", "name"]),
    phone: pick(r, ["mobile_phone_number", "phone", "mobile", "tel"]),
  };
}

export const bangkokToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export async function visitsOn(date: string): Promise<Visit[]> {
  const json = await iserviceGet("/api/ovst/v1/ovst_list", { date_start: date, date_end: date });
  return rowsOf(json).map(toVisit).filter((v) => v.hn);
}

/** ค้นด้วย HN (ตัวเลข) หรือชื่อ ส่งทั้ง search และ keyword เผื่อ API ใช้ชื่อพารามิเตอร์ต่างกัน แล้วกรองซ้ำฝั่งนี้ */
export async function searchPatients(q: string): Promise<Patient[]> {
  const term = q.trim();
  const params: Record<string, string> = { search: term, keyword: term, ...(/^\d+$/.test(term) ? { hn: term } : { name: term }) };
  const json = await iserviceGet("/api/patient/v1/patient_list", params);
  const needle = term.toLowerCase();
  return rowsOf(json).map(toPatient)
    .filter((p) => p.hn && (p.hn.includes(term) || p.name.toLowerCase().includes(needle)))
    .slice(0, 50);
}
