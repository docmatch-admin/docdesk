// Bangkok Medical Lab: API ภายในของเว็บแล็บ (ไม่ใช่ API ทางการ) — อ่านอย่างเดียว ห้ามเรียก endpoint ที่แก้ข้อมูล
// ค่าเข้าระบบ BML_USERNAME / BML_PASSWORD ใช้ฝั่ง server เท่านั้น ห้ามส่งไปหน้าเว็บหรือ AI

export const BML_BASE = "https://www.bangkokmedicalcenterlab.com";
export const BML_LOCATION_ID = "177";
/** แล็บกำหนดขั้นต่ำของ page_size */
export const BML_PAGE_SIZE = 100;

export interface BmlLabItem {
  id: string | number;
  ln?: string | null;
  lis_ln?: string | null;
  hn?: string | null;
  location_hn?: string | null;
  location_hn_extraction_status?: string | null;
  patient_name?: string | null;
  gender?: string | null;
  order_datetime?: string | null;
  status?: string | null;
  source_filename?: string | null;
  imported_at?: string | null;
  current_version_number?: number | null;
  version_count?: number | null;
}

/** ตำแหน่งหน้าถัดไป: ส่งกลับเป็น query cursor_value + cursor_id */
export interface BmlCursor { value: string; id: string }
export interface BmlPage { items: BmlLabItem[]; has_more: boolean; next_cursor: BmlCursor | null }

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);

/**
 * next_cursor ของแล็บเป็น object: อ่านค่าตำแหน่ง (เวลาที่ใช้เรียง) + id ของรายการสุดท้าย
 * รองรับชื่อ field ที่น่าจะเป็น (cursor_value/cursor_id, value/id, order_datetime/id) · อ่านไม่ได้ = null (หยุดแบ่งหน้า)
 */
export function parseBmlCursor(raw: unknown): BmlCursor | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const value = str(c.cursor_value) ?? str(c.value) ?? str(c.order_datetime) ?? str(c.sort_value);
  const id = str(c.cursor_id) ?? str(c.id) ?? str(c.lab_id);
  return value && id ? { value, id } : null;
}
export const sameCursor = (a: BmlCursor | null, b: BmlCursor | null) => !!a && !!b && a.value === b.value && a.id === b.id;

export class BmlError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) { super(message); this.name = "BmlError"; this.status = status; }
}

export const bmlEnabled = () => !!process.env.BML_USERNAME && !!process.env.BML_PASSWORD;

/** cookie ของ session (เก็บในหน่วยความจำของ instance เท่านั้น ไม่ลงฐานข้อมูล) */
let session: string | null = null;
export const resetBmlSession = () => { session = null; };

function cookiesOf(res: Response): string {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const list = h.getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
  return list.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
}

async function login(): Promise<string> {
  if (!bmlEnabled()) throw new BmlError("ยังไม่ได้ตั้ง BML_USERNAME / BML_PASSWORD");
  const res = await fetch(`${BML_BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ username: process.env.BML_USERNAME, password: process.env.BML_PASSWORD }),
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  // ไม่ใส่ body ของคำตอบใน error (อาจมีข้อมูลบัญชี)
  if (!res.ok) throw new BmlError(`เข้าระบบแล็บไม่สำเร็จ (${res.status})`, res.status);
  const cookie = cookiesOf(res);
  if (!cookie) throw new BmlError("เข้าระบบแล็บแล้วไม่ได้ session cookie");
  session = cookie;
  return cookie;
}

/** GET เท่านั้น · ได้ 401 = session หมดอายุ: login ใหม่ 1 ครั้งแล้วลองอีกครั้ง */
async function bmlGet(path: string, timeoutMs = 20000): Promise<Response> {
  const go = (cookie: string) => fetch(`${BML_BASE}${path}`, { headers: { cookie, accept: "*/*" }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  let res = await go(session ?? (await login()));
  if (res.status === 401) res = await go(await login());
  if (!res.ok) throw new BmlError(`ระบบแล็บตอบ ${res.status} (${path.split("?")[0]})`, res.status);
  return res;
}

/** รายการผลล่าสุดของคลินิก เรียงตามเวลาสั่งตรวจใหม่→เก่า */
export async function bmlListLabs(cursor?: BmlCursor | null): Promise<BmlPage> {
  const q = new URLSearchParams({ page_size: String(BML_PAGE_SIZE), location_id: BML_LOCATION_ID, sort_by: "order_datetime", sort_dir: "desc" });
  if (cursor) { q.set("cursor_value", cursor.value); q.set("cursor_id", cursor.id); }
  const body = (await (await bmlGet(`/api/labs?${q}`)).json()) as { items?: unknown; has_more?: unknown; next_cursor?: unknown } | null;
  return {
    items: Array.isArray(body?.items) ? (body.items as BmlLabItem[]) : [],
    has_more: body?.has_more === true,
    next_cursor: parseBmlCursor(body?.next_cursor),
  };
}

export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** PDF ของผล (ภาพสแกน) */
export async function bmlLabPdf(id: string): Promise<Buffer> {
  const res = await bmlGet(`/api/labs/${encodeURIComponent(id)}/pdf`, 45000);
  const type = res.headers.get("content-type") ?? "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PDF_BYTES) throw new BmlError("ไฟล์ PDF ใหญ่เกิน 25MB");
  if (!type.includes("pdf") && buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new BmlError(`ไม่ใช่ไฟล์ PDF (${type || "ไม่ระบุชนิด"})`);
  return buf;
}
