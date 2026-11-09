/**
 * อ่านข้อมูลคนไข้จาก iService ผ่าน Edge Function "iservice" ด้วย service role
 * ใช้ตอนผูก HN เพื่อเอาชื่อจริงจาก HIS ไม่ใช่ชื่อที่คนไข้หรือเจ้าหน้าที่พิมพ์
 */
export type HisLookup = { status: "found"; hn: string; name: string; phone: string } | { status: "not_found" } | { status: "error" };

export async function lookupHisPatient(hn: string): Promise<HisLookup> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !hn.trim()) return { status: "error" };
  try {
    const res = await fetch(`${url}/functions/v1/iservice`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "patient", hn: hn.trim() }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { status: "error" };
    const j = (await res.json()) as { patient?: { hn?: string; name?: string; phone?: string } | null };
    const p = j.patient;
    if (!p?.hn || !p.name?.trim()) return { status: "not_found" };
    return { status: "found", hn: p.hn, name: p.name.trim(), phone: p.phone ?? "" };
  } catch {
    return { status: "error" };
  }
}
