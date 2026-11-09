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

/** array แรกที่เจอในคำตอบ: [] | {data: []} | {data: {data|items|rows: []}} */
export function rowsOf(json: unknown): Record<string, unknown>[] {
  const seen = [json];
  while (seen.length) {
    const v = seen.shift();
    if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
    if (v && typeof v === "object") {
      for (const key of ["data", "items", "rows", "result", "list", "patients", "visits"]) {
        if (key in (v as Record<string, unknown>)) seen.push((v as Record<string, unknown>)[key]);
      }
    }
  }
  return [];
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
