import { supabaseAdmin } from "./supabase/admin";
import { hnVariants, linksOfConversation, sameHn } from "./patient-link-store";

/** การมาตรวจ 1 ครั้งจาก cache ของ iService (ovst_list) · เจ้าหน้าที่เห็นเท่านั้น ไม่ส่งให้ AI */
export interface VisitDrug { name: string; qty: number | null; unit: string | null; usage: string | null }
export interface VisitRow { vn: string; hn: string; date: string; time: string | null; doctor: string | null; rights: string | null; diagnosis: string | null; age: number | null; drugs: VisitDrug[] }
export interface VisitHistory { hn: string | null; total: number; visits: VisitRow[] }

/** ประวัติของคนไข้หลักของแชท (HN ที่ตั้งเป็นหลัก หรือของตัวเอง หรือ HN แรก) ล่าสุดก่อน */
export async function visitHistoryOf(conversationId: string, limit = 20): Promise<VisitHistory> {
  const db = supabaseAdmin();
  const [links, { data: conv }] = await Promise.all([
    linksOfConversation(conversationId),
    db.from("conversations").select("contacts(hn)").eq("id", conversationId).maybeSingle(),
  ]);
  if (!links.length) return { hn: null, total: 0, visits: [] };
  // HN หลักของแชท = contacts.hn (เหมือนกล่องนัด)
  const contact = (Array.isArray(conv?.contacts) ? conv?.contacts[0] : conv?.contacts) as { hn?: string | null } | null;
  const preferred = contact?.hn ?? null;
  const main = links.find((l) => preferred && sameHn(l.hn, preferred)) ?? links.find((l) => l.role === "patient") ?? links[0];
  const { data, count } = await db.from("his_visit_cache")
    .select("vn, hn, visit_date, visit_time, doctor_name, rights, diagnosis, age_y", { count: "exact" })
    .in("hn", hnVariants(main.hn))
    .order("visit_date", { ascending: false })
    .limit(limit);
  const rows = (data ?? []) as { vn: string; hn: string; visit_date: string; visit_time: string | null; doctor_name: string | null; rights: string | null; diagnosis: string | null; age_y: number | null }[];
  // ยาของทุก VN ในหน้านี้: query เดียว (in vn) ไม่วนทีละครั้ง
  const drugs = new Map<string, VisitDrug[]>();
  if (rows.length) {
    const { data: d } = await db.from("his_visit_drug_cache").select("vn, drug_name, qty, unit, usage_text").in("vn", rows.map((r) => r.vn)).order("drug_name");
    for (const x of (d ?? []) as { vn: string; drug_name: string; qty: number | string | null; unit: string | null; usage_text: string | null }[]) {
      const list = drugs.get(x.vn) ?? [];
      list.push({ name: x.drug_name, qty: x.qty == null ? null : Number(x.qty), unit: x.unit, usage: x.usage_text });
      drugs.set(x.vn, list);
    }
  }
  return {
    hn: main.hn,
    total: count ?? rows.length,
    visits: rows.map((r) => ({ vn: r.vn, hn: r.hn, date: r.visit_date, time: r.visit_time, doctor: r.doctor_name, rights: r.rights, diagnosis: r.diagnosis, age: r.age_y, drugs: drugs.get(r.vn) ?? [] })),
  };
}
