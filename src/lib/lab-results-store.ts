// ผลแล็บจากแล็บนอก: sync → เก็บ PDF ใน Storage (private) → จับคู่ HN → แจ้งคนไข้ทาง LINE + แจ้งทีมในกลุ่ม LINE
// ข้อมูลผลแล็บไม่ส่งเข้า AI: ไม่มีค่าผลในข้อความแชท ข้อความแจ้งเป็น sender_type 'system' ที่ suggest.ts ข้ามอยู่แล้ว
import { addDays, bangkokToday, dayButtonLabel, EN_PHRASES, englishDate, OPEN_STATUSES, pickLanguage, type LanguagePack } from "./appointment-rules";
import { languagePack } from "./appointment-language";
import { BmlError, bmlEnabled, bmlLabPdf, bmlListLabs, sameCursor, type BmlCursor, type BmlLabItem } from "./bml-client";
import { lineSendMessages } from "./channels/line";
import { LineQuotaError } from "./channels/line-log";
import {
  bmlTime, isUpdateNotice, labBeforeStart, LAB_BUCKET, LAB_COLUMNS, LAB_SENDER_NAME, LAB_SIGNED_URL_SECONDS, LAB_SYNC_LOOKBACK_DAYS, LAB_SYNC_MAX_PAGES,
  LAB_SYNC_STATE_KEY, LAB_TEAM_GROUP_KEY, labHn, labBookUrl, labMineUrl, labViewUrl, HEARING_SERVICE, type HearingRequest, inLabTab, bangkokDateRange, labSummary, patientNoticeFlex, staffTimelineText,
  resultHearingAppointment, shouldAutoNotify, syncAction, syncDue, teamNoticeText, versionOf,
  apptWhen, apptWhenFor, clampLabPage, CONVERSATION_LAB_LIMIT, LAB_PAGE_SIZE, labTabFilters, type LabAppointment, type LabResult, type LabSummary, type LabSyncState, type LabTab,
} from "./lab-results-rules";
import { loadAppointmentSettings, logAppointmentEvent, recipientIds } from "./appointment-store";
import { selfBookingAllowed, selfBookingDays, thaiDate, thaiTime, thaiWeekday } from "./booking-rules";
import { loadBusinessHours } from "./booking-store";
import { DEFAULT_CLINIC_PROFILE, getSetting } from "./mode";
import { hnVariants, linkedConversationsOf, linksOfConversation, normalizeHn, upsertPatient } from "./patient-link-store";
import { supabaseAdmin } from "./supabase/admin";

export class LabError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "LabError"; this.status = status; }
}

const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL || "https://docdesk-tau.vercel.app").replace(/\/$/, "");
const liffId = () => process.env.NEXT_PUBLIC_LINE_LIFF_ID?.trim() || null;
const nowIso = () => new Date().toISOString();
const LAB_PDF_PER_RUN = 25;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

async function saveSetting(key: string, value: unknown) {
  await supabaseAdmin().from("settings").upsert({ key, value }, { onConflict: "key" });
}

async function loadResult(id: string): Promise<LabResult | null> {
  if (!/^[\w-]{1,64}$/.test(id)) return null;
  const { data } = await supabaseAdmin().from("lab_results").select(LAB_COLUMNS).eq("id", id).maybeSingle();
  return (data as unknown as LabResult | null) ?? null;
}

// ---------------------------------------------------------------------------
// sync จากระบบแล็บ (อ่านอย่างเดียว)
// ---------------------------------------------------------------------------
export interface LabSyncSummary {
  skipped?: "not_configured" | "too_soon";
  fetched: number; created: number; updated: number; pdfFailed: number;
  notified: number; unreachable: number; team: number; backfill?: boolean;
}

async function patientExists(hn: string): Promise<boolean> {
  const { data } = await supabaseAdmin().from("patients").select("hn").eq("hn", hn).maybeSingle();
  return !!data;
}

async function storePdf(bmlId: string, version: number): Promise<string> {
  const pdf = await bmlLabPdf(bmlId);
  const path = `${bmlId.replace(/[^\w-]/g, "_")}/v${version}.pdf`;
  const { error } = await supabaseAdmin().storage.from(LAB_BUCKET).upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`เก็บไฟล์ไม่สำเร็จ: ${error.message}`);
  return path;
}

/** บันทึกรายการเดียว คืนแถวล่าสุด + เป็นผลใหม่/แล็บแก้ผล/เหมือนเดิม */
async function upsertItem(item: BmlLabItem, opts: { backfill: boolean; allowPdf: boolean }): Promise<{ row: LabResult; action: "new" | "updated" | "same"; pdfFailed: boolean; pdfTried?: boolean } | null> {
  const db = supabaseAdmin();
  const bmlId = String(item.id ?? "").trim();
  if (!bmlId) return null;
  const { data: found } = await db.from("lab_results").select(LAB_COLUMNS).eq("bml_id", bmlId).maybeSingle();
  const existing = (found as unknown as LabResult | null) ?? null;
  const version = versionOf(item.current_version_number);
  const action = syncAction(existing, version);

  const base = {
    ln: item.ln ?? null, lis_ln: item.lis_ln ?? null,
    location_hn: item.location_hn ?? null, hn_extraction_status: item.location_hn_extraction_status ?? null,
    patient_name: item.patient_name ?? null, gender: item.gender ?? null,
    order_datetime: bmlTime(item.order_datetime), status: item.status ?? null, bml_imported_at: bmlTime(item.imported_at),
  };
  // จับคู่อัตโนมัติ (ไม่แตะแถวที่เจ้าหน้าที่จับคู่เอง)
  let match: Partial<LabResult> = {};
  if (existing?.match_status !== "manual") {
    const hn = labHn(item.location_hn, item.location_hn_extraction_status);
    // แล็บอ่าน HN จากใบส่งตรวจได้ = ผูกเลย แม้คนไข้ยังไม่อยู่ในตาราง patients ของ DocDesk (คนไข้ใหม่) → สร้างแถวคนไข้ให้
    if (hn && !(await patientExists(hn))) await upsertPatient({ hn });
    match = hn ? { patient_id: hn, match_status: "matched" } : { patient_id: null, match_status: "unmatched" };
  }

  if (action === "same") {
    const changed = existing && (existing.status !== base.status || existing.location_hn !== base.location_hn || existing.hn_extraction_status !== base.hn_extraction_status
      || ("patient_id" in match && existing.patient_id !== match.patient_id));
    if (!changed) return { row: existing!, action, pdfFailed: false };
    const { data } = await db.from("lab_results").update({ ...base, ...match, updated_at: nowIso() }).eq("id", existing!.id).select(LAB_COLUMNS);
    return { row: ((data ?? [])[0] as unknown as LabResult) ?? existing!, action, pdfFailed: false };
  }

  // ผลใหม่หรือแล็บแก้ผล: โหลด PDF ฉบับล่าสุด (โหลดไม่ได้ เก็บ error ไว้ รอบหน้าลองใหม่)
  // เกินเวลาของรอบนี้: บันทึกรายการไว้ก่อน รอบหน้าค่อยโหลดไฟล์
  let pdf: Partial<LabResult> = {};
  let pdfFailed = false;
  if (opts.allowPdf) {
    try {
      pdf = { pdf_path: await storePdf(bmlId, version), pdf_version: version, pdf_error: null };
    } catch (e) {
      pdfFailed = true;
      pdf = { pdf_error: errText(e) };
    }
  }
  const versionBump = !!existing && version > existing.version_number;
  if (!existing) {
    const { data, error } = await db.from("lab_results").upsert({
      bml_id: bmlId, ...base, ...match, ...pdf, version_number: version, view_count: 0,
      // เริ่มระบบครั้งแรก: ผลเก่าที่มีอยู่แล้วไม่แจ้งคนไข้/ทีม
      notify_status: "pending",
      // ผลเก่าตอนเริ่มระบบ: ถือว่าแจ้งแล้ว (notified_at = ตอนนำเข้า) ไม่ส่ง LINE ใด ๆ
      updated_at: nowIso(),
    }, { onConflict: "bml_id" }).select(LAB_COLUMNS);
    if (error) throw error;
    return { row: (data ?? [])[0] as unknown as LabResult, action: "new", pdfFailed, pdfTried: opts.allowPdf };
  }
  const { data, error } = await db.from("lab_results").update({
    ...base, ...match, ...pdf, version_number: version, updated_at: nowIso(),
    // แล็บแก้ผล: แจ้งคนไข้ใหม่ ("ผลมีการปรับปรุง")
    // (ไม่ได้ผูก LINE ตอนผลออก ก็ไม่แจ้งฉบับแก้อัตโนมัติ — เจ้าหน้าที่กดส่งเอง)
    ...(versionBump && existing.notify_status !== "skipped" && existing.notify_status !== "unreachable" ? { notify_status: "pending" } : {}),
  }).eq("id", existing.id).select(LAB_COLUMNS);
  if (error) throw error;
  return { row: ((data ?? [])[0] as unknown as LabResult) ?? existing, action: versionBump ? "updated" : "same", pdfFailed, pdfTried: opts.allowPdf };
}

/** pg_cron ทุก 30 นาที 13:00–18:00 น. (→ /api/cron/lab-results) · เรียกซ้ำภายใน 15 นาทีข้ามโดยไม่เรียกระบบแล็บ
 * เจอผลใหม่ในรอบไหน แจ้งคนไข้ทาง LINE ในรอบนั้นทันที */
export async function runLabSync(now = Date.now()): Promise<LabSyncSummary> {
  const summary: LabSyncSummary = { fetched: 0, created: 0, updated: 0, pdfFailed: 0, notified: 0, unreachable: 0, team: 0 };
  if (!bmlEnabled()) return { ...summary, skipped: "not_configured" };
  const state = await getSetting<LabSyncState>(LAB_SYNC_STATE_KEY, {});
  if (!syncDue(state, now)) return { ...summary, skipped: "too_soon" };
  // จองรอบก่อนเรียกระบบแล็บ: ล้มกลางทาง รอบถัดไปก็ยังห่าง 15 นาที
  await saveSetting(LAB_SYNC_STATE_KEY, { ...state, last_run_at: new Date(now).toISOString() });

  const db = supabaseAdmin();
  const { data: anyRow } = await db.from("lab_results").select("id").limit(1);
  const backfill = !state.initialized && !(anyRow ?? []).length;
  if (backfill) summary.backfill = true;
  const cutoff = new Date(now - LAB_SYNC_LOOKBACK_DAYS * 86_400_000).toISOString();

  try {
    const items: BmlLabItem[] = [];
    let cursor: BmlCursor | null = null;
    for (let page = 0; page < LAB_SYNC_MAX_PAGES; page++) {
      const res = await bmlListLabs(cursor);
      items.push(...res.items);
      const oldest = res.items.at(-1)?.order_datetime;
      // has_more=false หยุด · cursor อ่านไม่ได้/ซ้ำเดิม หยุด (กันวนไม่จบ) · เลยช่วงที่ดูย้อนหลังแล้ว หยุด
      if (!res.has_more || !res.next_cursor || sameCursor(res.next_cursor, cursor) || (oldest && oldest < cutoff)) break;
      cursor = res.next_cursor;
    }
    summary.fetched = items.length;

    const touched: { row: LabResult; action: "new" | "updated" | "same" }[] = [];
    // route มีเวลา 60 วินาที: โหลด PDF ไม่เกิน LAB_PDF_PER_RUN ไฟล์และไม่เกิน ~35 วินาที ที่เหลือโหลดรอบถัดไป
    const started = Date.now();
    let pdfs = 0;
    for (const item of items) {
      // ระบบเริ่มที่ LN 26129150 (HN 4807): ผลก่อนหน้านั้นไม่นำเข้าเลย
      if (labBeforeStart(item.ln)) continue;
      if (item.order_datetime && (bmlTime(item.order_datetime) ?? "") < cutoff && !backfill) continue;
      const allowPdf = pdfs < LAB_PDF_PER_RUN && Date.now() - started < 35_000;
      const r = await upsertItem(item, { backfill, allowPdf });
      if (r?.pdfTried) pdfs++;
      if (!r) continue;
      if (r.pdfFailed) summary.pdfFailed++;
      if (r.action === "new") summary.created++;
      if (r.action === "updated") summary.updated++;
      touched.push(r);
    }

    // รอบแรกก็แจ้ง: ผลเก่า (skipped) ไม่ผ่าน shouldAutoNotify และ team_notified_version ตั้งไว้แล้ว จึงไม่ถูกส่ง
    {
      for (const { row } of touched) {
        // แจ้งทีม: ผลใหม่ทุกรายการ + ทุกครั้งที่แล็บแก้ผล (เมื่อมีไฟล์แล้ว)
        let reachable: boolean | null = null;
        if (shouldAutoNotify(row, now)) {
          const n = await notifyLabResult(row.id, { now }).catch(async (e) => { console.error("lab notify failed", errText(e)); return null; });
          if (n?.sent) summary.notified++;
          if (n && !n.sent && n.reason === "unreachable") summary.unreachable++;
          reachable = n ? n.sent || n.reason !== "unreachable" : null;
        }
        if (row.pdf_path && (row.team_notified_version ?? 0) < row.version_number) {
          if (await notifyTeam(row, reachable).catch(() => false)) summary.team++;
        }
      }
    }
    await saveSetting(LAB_SYNC_STATE_KEY, { last_run_at: new Date(now).toISOString(), last_ok_at: nowIso(), last_error: null, initialized: true });
    return summary;
  } catch (e) {
    await saveSetting(LAB_SYNC_STATE_KEY, { ...state, last_run_at: new Date(now).toISOString(), last_error: e instanceof BmlError ? e.message : errText(e) });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// แจ้งคนไข้ทาง LINE (บัญชีที่ผูก HN จาก QR ใบนัด: คนไข้ + ญาติ)
// ---------------------------------------------------------------------------
interface LineTarget { conversationId: string; userId: string; language: string | null }

/** บัญชี LINE ที่ผูกกับ HN นี้: ส่งได้ / ส่งไม่ได้เพราะบล็อก·เลิกติดตาม OA หรือแชทถูกเก็บถาวร */
async function lineTargetsOf(hn: string): Promise<{ targets: LineTarget[]; blocked: string[] }> {
  const links = await linkedConversationsOf(hn);
  if (!links.length) return { targets: [], blocked: [] };
  const { data } = await supabaseAdmin().from("conversations")
    .select("id, archived, contacts(external_id, line_unfollowed_at, language), channels(type)")
    .in("id", links.map((l) => l.conversation_id));
  const out: LineTarget[] = [];
  const blocked: string[] = [];
  for (const c of (data ?? []) as { id: string; archived?: boolean | null; contacts: unknown; channels: unknown }[]) {
    const contact = (Array.isArray(c.contacts) ? c.contacts[0] : c.contacts) as { external_id?: string; line_unfollowed_at?: string | null; language?: string | null } | null;
    const channel = (Array.isArray(c.channels) ? c.channels[0] : c.channels) as { type?: string } | null;
    if (channel?.type !== "line" || !contact?.external_id) continue;
    if (contact.line_unfollowed_at) { blocked.push("คนไข้บล็อกหรือเลิกติดตาม LINE OA"); continue; }
    if (c.archived) { blocked.push("แชท LINE นี้เป็นแชทนำเข้า (ส่งไม่ได้)"); continue; }
    out.push({ conversationId: c.id, userId: contact.external_id, language: contact.language ?? null });
  }
  return { targets: out, blocked };
}

/** ข้อความ error ที่เจ้าหน้าที่อ่านเข้าใจ + เก็บข้อความจริงจาก LINE ไว้ต่อท้าย */
export function lineErrorText(e: unknown): string {
  if (e instanceof LineQuotaError) return "โควตา LINE เดือนนี้หมด";
  const raw = errText(e);
  if (/403|block|not.*friend|hasn't added|unfollow/i.test(raw)) return `คนไข้บล็อกหรือเลิกติดตาม LINE OA — ${raw}`.slice(0, 300);
  return raw;
}

async function hearingAppointment(hn: string, now: number): Promise<LabAppointment | null> {
  const today = bangkokToday(now);
  const { data } = await supabaseAdmin().from("appointments")
    .select("id, appoint_date, time_mode, time_start, time_end, status, purpose_text")
    .in("hn", hnVariants(hn)).in("status", OPEN_STATUSES).gte("appoint_date", today).lte("appoint_date", addDays(today, 120));
  return resultHearingAppointment((data ?? []) as unknown as LabAppointment[], today);
}

/** หน้าผลแล็บของเจ้าหน้าที่: นัดฟังผลที่ยังเปิดอยู่ของแต่ละ HN (query เดียว) → ข้อความวัน/เวลา */
export async function hearingAppointmentsByHn(hns: string[], now = Date.now()): Promise<Record<string, string>> {
  const ids = [...new Set(hns.filter(Boolean))];
  if (!ids.length) return {};
  const today = bangkokToday(now);
  const { data } = await supabaseAdmin().from("appointments")
    .select("id, hn, appoint_date, time_mode, time_start, time_end, status, purpose_text")
    .in("hn", ids.flatMap(hnVariants)).in("status", OPEN_STATUSES).gte("appoint_date", today).lte("appoint_date", addDays(today, 120));
  const rows = (data ?? []) as unknown as (LabAppointment & { hn: string })[];
  const bare = (h: string) => String(h ?? "").trim().replace(/^0+/, "");
  const out: Record<string, string> = {};
  for (const id of ids) {
    const a = resultHearingAppointment(rows.filter((r) => bare(r.hn) === bare(id)), today);
    if (a) out[id] = apptWhen(a);
  }
  return out;
}

async function clinicName(): Promise<string> {
  const profile = await getSetting<{ name?: string }>("clinic_profile", DEFAULT_CLINIC_PROFILE);
  return profile?.name?.trim() || DEFAULT_CLINIC_PROFILE.name;
}

export type NotifyResult = { sent: true; accounts: number } | { sent: false; reason: "unmatched" | "no_pdf" | "unreachable" | "failed" | "no_liff"; error?: string };

/** ส่ง "ผลแล็บของคุณออกแล้ว" (หรือ "มีการปรับปรุง") ไปทุกบัญชี LINE ที่ผูก HN — ไม่ส่งไฟล์ PDF ในแชท ส่งแค่ปุ่มเปิดผ่าน LIFF */
export async function notifyLabResult(id: string, opts: { now?: number } = {}): Promise<NotifyResult> {
  const now = opts.now ?? Date.now();
  const db = supabaseAdmin();
  const r = await loadResult(id);
  if (!r) throw new LabError("ไม่พบผลแล็บ", 404);
  if (!r.patient_id) return { sent: false, reason: "unmatched" };
  if (!r.pdf_path) return { sent: false, reason: "no_pdf" };
  // ยังไม่ได้ตั้ง LIFF: ปุ่ม "ดูผล" จะเปิดไม่ได้ ยังไม่ส่ง (ค้างเป็นรอแจ้ง รอบ sync ถัดไปหลังตั้งค่าส่งเอง)
  if (!liffId()) {
    await db.from("lab_results").update({ notify_error: "ยังไม่ได้ตั้ง NEXT_PUBLIC_LINE_LIFF_ID — ยังไม่ส่งแจ้งคนไข้", updated_at: nowIso() }).eq("id", r.id);
    return { sent: false, reason: "no_liff" };
  }
  const { targets, blocked } = await lineTargetsOf(r.patient_id);
  if (!targets.length && blocked.length) {
    // ผูก LINE ไว้แต่ส่งไม่ได้ (บล็อก/เลิกติดตาม) = ส่งไม่สำเร็จ ให้เห็นเป็นสีแดงในหน้าผลแล็บ
    await db.from("lab_results").update({ notify_status: "failed", notify_error: blocked[0], updated_at: nowIso() }).eq("id", r.id);
    return { sent: false, reason: "failed", error: blocked[0] };
  }
  if (!targets.length) {
    // ไม่ได้ผูก LINE: ไม่ส่งแจ้งใด ๆ ไม่เข้ารายการโทร แค่แสดงสถานะในหน้าผลแล็บ (ผลยังเก็บไว้ แพทย์เปิดดูได้)
    await db.from("lab_results").update({ notify_status: "unreachable", notify_error: "ไม่ได้ผูก LINE", updated_at: nowIso() }).eq("id", r.id);
    return { sent: false, reason: "unreachable" };
  }
  const [clinic, appointment, settings] = await Promise.all([clinicName(), hearingAppointment(r.patient_id, now), loadAppointmentSettings()]);
  const updated = isUpdateNotice(r);
  // ภาษาของแต่ละบัญชี LINE (เหมือนข้อความนัด): ไทย = ฉบับเดิม · อื่น ๆ = pack (แปลครั้งเดียวต่อภาษา AI ล่ม = อังกฤษ ไม่กันการส่ง)
  const packs = new Map<string, LanguagePack>();
  const packOf = async (language: string | null): Promise<LanguagePack | null> => {
    if (pickLanguage(language) === "th") return null;
    const code = (language ?? "").trim().toLowerCase();
    if (!packs.has(code)) {
      const pack = await languagePack(code, settings).catch((e) => { console.error("lab notice language", errText(e)); return null; });
      packs.set(code, pack ?? { lang: "en", phrases: { ...EN_PHRASES }, template: settings.template_en });
    }
    return packs.get(code)!;
  };
  const clinicEn = settings.clinic_name_en.trim() || clinic;
  let sent = 0;
  const errors: string[] = [...blocked];
  for (const t of targets) {
    const showName = (await linksOfConversation(t.conversationId)).length > 1;
    const pack = await packOf(t.language);
    const notice = { clinic: pack ? clinicEn : clinic, patientName: r.patient_name, showName, updated, orderDate: r.order_datetime, viewUrl: labViewUrl(liffId(), appUrl(), r.id), mineUrl: labMineUrl(liffId(), appUrl()), bookUrl: labBookUrl(liffId(), appUrl(), r.id), appointment, pack };
    try {
      await lineSendMessages(t.userId, [patientNoticeFlex(notice)], undefined, { kind: "lab", conversationId: t.conversationId });
      await db.from("messages").insert({
        conversation_id: t.conversationId, direction: "out", sender_type: "system", body: staffTimelineText(notice, `${appUrl().replace(/\/$/, "")}/api/lab-results/${r.id}/pdf`), language: pack ? pack.lang : "th",
        external_id: null, imported_sender_name: LAB_SENDER_NAME,
      });
      sent++;
    } catch (e) {
      const err = lineErrorText(e);
      errors.push(err);
      console.error("lab notice send failed", err);
    }
  }
  if (!sent) {
    await db.from("lab_results").update({ notify_status: "failed", notify_error: errors.at(-1) ?? "ส่งไม่สำเร็จ", updated_at: nowIso() }).eq("id", r.id);
    return { sent: false, reason: "failed", error: errors.at(-1) };
  }
  await db.from("lab_results").update({
    notify_status: "sent", notified_at: nowIso(), notified_version: r.version_number, updated_at: nowIso(),
    // ส่งถึงบางบัญชี: เก็บเหตุผลของบัญชีที่ส่งไม่ถึงไว้ดู
    notify_error: errors.length ? `ส่งไม่ถึง ${errors.length} บัญชี: ${errors.join(" | ")}`.slice(0, 300) : null,
  }).eq("id", r.id);
  return { sent: true, accounts: sent };
}

// ---------------------------------------------------------------------------
// แจ้งทีม (กลุ่ม LINE ของแพทย์/ทีม)
// ---------------------------------------------------------------------------
export interface TeamGroupSetting { group_id?: string | null; candidate_id?: string | null; candidate_at?: string | null }

export async function teamGroupSetting(): Promise<TeamGroupSetting> {
  return getSetting<TeamGroupSetting>(LAB_TEAM_GROUP_KEY, {});
}
const teamGroupId = async () => process.env.LAB_TEAM_LINE_GROUP_ID?.trim() || (await teamGroupSetting()).group_id?.trim() || null;

export async function setTeamGroup(groupId: string | null) {
  const id = groupId?.trim() || null;
  if (id && !/^C[0-9a-f]{32}$/i.test(id)) throw new LabError("Group ID ของ LINE ขึ้นต้นด้วย C ตามด้วยตัวอักษร 32 ตัว");
  await saveSetting(LAB_TEAM_GROUP_KEY, { ...(await teamGroupSetting()), group_id: id });
}

/** webhook: OA ถูกเชิญเข้ากลุ่ม → เก็บไว้ให้แอดมินกดเลือกเป็นกลุ่มแจ้งผลแล็บ (ไม่ตั้งให้อัตโนมัติ) */
export async function rememberGroupCandidate(groupId: string) {
  if (!/^C[0-9a-f]{32}$/i.test(groupId)) return;
  await saveSetting(LAB_TEAM_GROUP_KEY, { ...(await teamGroupSetting()), candidate_id: groupId, candidate_at: nowIso() });
}

/** แจ้งกลุ่ม LINE แพทย์: พักไว้ เปิดด้วย env LAB_TEAM_NOTIFY=on เท่านั้น (ค่าเริ่มต้นปิด) */
export const labTeamNotifyEnabled = () => process.env.LAB_TEAM_NOTIFY?.trim().toLowerCase() === "on";

async function notifyTeam(r: LabResult, reachable: boolean | null): Promise<boolean> {
  if (!labTeamNotifyEnabled()) return false;
  const group = await teamGroupId();
  if (!group) return false;
  const text = teamNoticeText(r, { updated: r.version_number > 1 && (r.team_notified_version ?? 0) > 0, appUrl: appUrl(), reachable });
  try {
    await lineSendMessages(group, [{ type: "text", text }], undefined, { kind: "lab" });
  } catch (e) {
    console.error("lab team notice failed", errText(e));
    return false;
  }
  await supabaseAdmin().from("lab_results").update({ team_notified_version: r.version_number }).eq("id", r.id);
  return true;
}

// ---------------------------------------------------------------------------
// คนไข้เปิดดูผล (LIFF): ยืนยันว่า LINE userId เป็นบัญชีที่ผูก HN ของผลนี้
// ---------------------------------------------------------------------------
/** ตรวจ ID token ของ LIFF กับ LINE คืน userId */
export async function verifyLineIdToken(idToken: string): Promise<string> {
  const clientId = process.env.LINE_LOGIN_CHANNEL_ID?.trim();
  if (!clientId) throw new LabError("ยังไม่ได้ตั้งค่า LINE Login", 503);
  const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: clientId }),
    signal: AbortSignal.timeout(10000),
  });
  const body = (await res.json().catch(() => null)) as { sub?: string } | null;
  if (!res.ok || !body?.sub) throw new LabError("ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจาก LINE อีกครั้ง", 401);
  return body.sub;
}

/** บัญชี LINE นี้ผูกกับ HN นี้ไหม (คนไข้หรือญาติ) */
async function lineUserOwnsHn(userId: string, hn: string): Promise<boolean> {
  const db = supabaseAdmin();
  const { data: contacts } = await db.from("contacts").select("id, channel_id").eq("external_id", userId);
  const rows = (contacts ?? []) as { id: string; channel_id: string }[];
  if (!rows.length) return false;
  const { data: channels } = await db.from("channels").select("id, type").in("id", [...new Set(rows.map((c) => c.channel_id))]);
  const lineChannels = new Set(((channels ?? []) as { id: string; type: string }[]).filter((c) => c.type === "line").map((c) => c.id));
  const ids = rows.filter((c) => lineChannels.has(c.channel_id)).map((c) => c.id);
  if (!ids.length) return false;
  const { data: convs } = await db.from("conversations").select("id").in("contact_id", ids);
  const convIds = new Set(((convs ?? []) as { id: string }[]).map((c) => c.id));
  return (await linkedConversationsOf(hn)).some((l) => convIds.has(l.conversation_id));
}

async function signedPdfUrl(path: string, download?: string): Promise<string> {
  const { data, error } = await supabaseAdmin().storage.from(LAB_BUCKET).createSignedUrls([path], LAB_SIGNED_URL_SECONDS, download ? { download } : undefined);
  const url = (data ?? [])[0]?.signedUrl;
  if (error || !url) throw new LabError("เปิดไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง", 502);
  return url;
}

/** HN ทั้งหมดที่บัญชี LINE นี้ผูกไว้ (คนไข้เองหรือญาติ) + แชทของบัญชีนี้ */
async function lineUserLinks(userId: string): Promise<{ hns: string[]; conversationIds: string[] }> {
  const db = supabaseAdmin();
  const { data: contacts } = await db.from("contacts").select("id, channel_id").eq("external_id", userId);
  const rows = (contacts ?? []) as { id: string; channel_id: string }[];
  if (!rows.length) return { hns: [], conversationIds: [] };
  const { data: channels } = await db.from("channels").select("id, type").in("id", [...new Set(rows.map((c) => c.channel_id))]);
  const lineChannels = new Set(((channels ?? []) as { id: string; type: string }[]).filter((c) => c.type === "line").map((c) => c.id));
  const ids = rows.filter((c) => lineChannels.has(c.channel_id)).map((c) => c.id);
  if (!ids.length) return { hns: [], conversationIds: [] };
  const { data: convs } = await db.from("conversations").select("id").in("contact_id", ids);
  const conversationIds = ((convs ?? []) as { id: string }[]).map((c) => c.id);
  const hns = new Set<string>();
  for (const c of conversationIds) {
    for (const l of await linksOfConversation(c)) {
      const h = normalizeHn(l.hn);
      if (h) hns.add(h);
    }
  }
  return { hns: [...hns], conversationIds };
}

/** ภาษาของหน้า LIFF ตามบัญชี LINE นี้: ไทย / อังกฤษ (ทุกภาษาที่ไม่ใช่ไทย) · ไม่มีรายชื่อ = null (หน้าเว็บใช้ภาษาเบราว์เซอร์) */
export type PatientLang = "th" | "en";
async function lineUserLang(userId: string): Promise<PatientLang | null> {
  const db = supabaseAdmin();
  const { data: contacts } = await db.from("contacts").select("channel_id, language").eq("external_id", userId);
  const rows = (contacts ?? []) as { channel_id: string; language: string | null }[];
  if (!rows.length) return null;
  const { data: channels } = await db.from("channels").select("id, type").in("id", [...new Set(rows.map((c) => c.channel_id))]);
  const line = new Set(((channels ?? []) as { id: string; type: string }[]).filter((c) => c.type === "line").map((c) => c.id));
  const contact = rows.find((c) => line.has(c.channel_id));
  return contact ? pickLanguage(contact.language) : null;
}
/** อังกฤษ: วันที่แบบอังกฤษ (ไม่ใช้ AI) */
const EN_DATES = {} as const;

export interface PatientAppointment { id: string; when: string; status: string; canConfirm: boolean }
const patientAppt = (a: LabAppointment | null, lang: PatientLang | null = "th"): PatientAppointment | null =>
  a ? { id: a.id, when: lang === "en" ? apptWhenFor(a, EN_DATES) : apptWhen(a), status: a.status, canConfirm: a.status === "scheduled" || a.status === "reschedule_requested" } : null;

export async function patientViewLab(id: string, idToken: string, now = Date.now()) {
  const userId = await verifyLineIdToken(idToken);
  const r = await loadResult(id);
  // ไม่บอกว่ามีผลนี้อยู่หรือไม่ ถ้าไม่ใช่เจ้าของ
  if (!r || !r.patient_id || !r.pdf_path || !(await lineUserOwnsHn(userId, r.patient_id))) {
    throw new LabError("ไม่พบผลแล็บนี้ในบัญชี LINE ของคุณ", 404);
  }
  const [url, downloadUrl, appointment, pending, lang] = await Promise.all([
    signedPdfUrl(r.pdf_path),
    signedPdfUrl(r.pdf_path, `lab-${(r.order_datetime ?? "").slice(0, 10) || r.ln || "result"}.pdf`),
    hearingAppointment(r.patient_id, now),
    pendingHearingRequest(r.patient_id, now),
    lineUserLang(userId),
  ]);
  const at = nowIso();
  await supabaseAdmin().from("lab_results").update({ view_count: (r.view_count ?? 0) + 1, first_viewed_at: r.first_viewed_at ?? at, last_viewed_at: at }).eq("id", r.id);
  return {
    url, downloadUrl, expiresIn: LAB_SIGNED_URL_SECONDS, patientName: r.patient_name, orderDate: r.order_datetime, ln: r.ln,
    updated: r.version_number > 1, version: r.version_number, appointment: patientAppt(appointment, lang),
    request: appointment ? null : requestView(pending, lang), lang,
  };
}

/** หน้า "ผลแล็บของฉัน": ผลทุกรายการของทุก HN ที่บัญชี LINE นี้ผูก เรียงล่าสุดก่อน (ไม่มี URL ไฟล์ เปิดทีละรายการ) */
export async function patientLabList(idToken: string, now = Date.now()) {
  const userId = await verifyLineIdToken(idToken);
  const [{ hns }, lang] = await Promise.all([lineUserLinks(userId), lineUserLang(userId)]);
  if (!hns.length) return { linked: false, results: [], lang };
  const { data } = await supabaseAdmin().from("lab_results").select(LAB_COLUMNS).in("patient_id", hns).order("order_datetime", { ascending: false }).limit(200);
  const rows = ((data ?? []) as unknown as LabResult[]).filter((r) => r.pdf_path);
  const appts = new Map<string, PatientAppointment | null>();
  const requests = new Map<string, PatientRequest | null>();
  for (const hn of new Set(rows.map((r) => r.patient_id as string))) {
    const a = await hearingAppointment(hn, now);
    appts.set(hn, patientAppt(a, lang));
    requests.set(hn, a ? null : requestView(await pendingHearingRequest(hn, now), lang));
  }
  return {
    linked: true, lang,
    results: rows.map((r) => ({
      id: r.id, ln: r.ln, orderDate: r.order_datetime, patientName: hns.length > 1 ? r.patient_name : null,
      updated: r.version_number > 1, version: r.version_number, viewed: !!r.first_viewed_at, appointment: appts.get(r.patient_id as string) ?? null,
      request: requests.get(r.patient_id as string) ?? null,
    })),
  };
}

/** คนไข้กดยืนยันนัดฟังผลจากหน้า LIFF: ต้องเป็นบัญชีที่รับข้อความของนัดนั้น */
export async function patientConfirmAppointment(appointmentId: string, idToken: string, now = Date.now()) {
  const userId = await verifyLineIdToken(idToken);
  const db = supabaseAdmin();
  const { data } = await db.from("appointments").select("id, hn, conversation_id, status, appoint_date").eq("id", appointmentId).maybeSingle();
  const appt = data as { id: string; hn: string | null; conversation_id: string | null; status: string; appoint_date: string } | null;
  const { conversationIds } = await lineUserLinks(userId);
  const allowed = appt ? (await recipientIds(appt)).find((c) => conversationIds.includes(c)) : undefined;
  if (!appt || !allowed) throw new LabError("ไม่พบนัดนี้ในบัญชี LINE ของคุณ", 404);
  if (appt.status === "confirmed") return { status: "confirmed" };
  if (!(OPEN_STATUSES as string[]).includes(appt.status) || appt.appoint_date < bangkokToday(now)) throw new LabError("นัดนี้ปิดแล้ว ยืนยันไม่ได้", 409);
  await db.from("appointments").update({ status: "confirmed", updated_at: nowIso() }).eq("id", appt.id);
  await logAppointmentEvent(appt.id, "confirmed", "customer", { channel: "line", detail: { conversation_id: allowed, via: "lab_liff" } });
  return { status: "confirmed" };
}

// ---------------------------------------------------------------------------
// หน้าเจ้าหน้าที่
// ---------------------------------------------------------------------------
export async function staffPdfUrl(id: string): Promise<string> {
  const r = await loadResult(id);
  if (!r?.pdf_path) throw new LabError("ยังไม่มีไฟล์ผลนี้", 404);
  return signedPdfUrl(r.pdf_path);
}

const searchTerm = (q: string) => q.replace(/[,()%*\\:"']/g, " ").trim().slice(0, 60);

export interface LabPage { rows: LabResult[]; total: number; page: number; pageSize: number }
export interface LabListOptions { tab?: LabTab; q?: string; id?: string | null; conversationId?: string | null; from?: string | null; to?: string | null; page?: number }

/**
 * รายการผลแล็บทีละหน้า (30 รายการ) · ตัวกรองแท็บ/ค้นหา/วันที่อยู่ใน SQL ทั้งหมด แล้วค่อยแบ่งหน้า (count: exact)
 * แผงขวาของแชท (conversationId): ไม่แบ่งหน้า ไม่เกิน 50 รายการ
 */
export async function listLabResults(opts: LabListOptions = {}): Promise<LabPage> {
  let hns: string[] | null = null;
  if (opts.conversationId) {
    hns = [...new Set((await linksOfConversation(opts.conversationId)).map((l) => normalizeHn(l.hn)).filter((h): h is string => !!h))];
    if (!hns.length) return { rows: [], total: 0, page: 1, pageSize: CONVERSATION_LAB_LIMIT };
  }
  const build = () => {
    let qy = supabaseAdmin().from("lab_results").select(LAB_COLUMNS, { count: "exact" });
    if (opts.id) qy = qy.eq("id", opts.id);
    const range = bangkokDateRange(opts.from, opts.to);
    if (range.gte) qy = qy.gte("order_datetime", range.gte);
    if (range.lt) qy = qy.lt("order_datetime", range.lt);
    if (hns) qy = qy.in("patient_id", hns);
    for (const f of labTabFilters(opts.tab)) qy = "isNull" in f ? qy.is(f.col, null) : qy.eq(f.col, f.eq);
    const q = searchTerm(opts.q ?? "");
    if (q) {
      const hn = normalizeHn(q);
      qy = qy.or(`patient_name.ilike.%${q}%,ln.ilike.%${q}%,location_hn.ilike.%${q}%${hn ? `,patient_id.eq.${hn}` : ""}`);
    }
    // id ต่อท้ายให้ลำดับคงที่ระหว่างหน้า (ผลที่เวลาสั่งตรวจเท่ากัน)
    return qy.order("order_datetime", { ascending: false }).order("id", { ascending: false });
  };
  if (hns) {
    const { data, count } = await build().limit(CONVERSATION_LAB_LIMIT);
    const rows = (data ?? []) as unknown as LabResult[];
    return { rows, total: count ?? rows.length, page: 1, pageSize: CONVERSATION_LAB_LIMIT };
  }
  const fetchPage = async (page: number) => {
    const { data, count } = await build().range((page - 1) * LAB_PAGE_SIZE, page * LAB_PAGE_SIZE - 1);
    return { rows: (data ?? []) as unknown as LabResult[], total: count ?? 0 };
  };
  let page = clampLabPage(opts.page);
  let got = await fetchPage(page);
  // ขอหน้าเกินหน้าสุดท้าย (เช่นรายการลดลงระหว่างดู): PostgREST ตอบ range ไม่ได้ (ไม่มี count)
  // → ดูจำนวนจากหน้าแรก แล้วส่งหน้าสุดท้ายแทนหน้าว่าง
  if (!got.rows.length && page > 1) {
    const first = await fetchPage(1);
    page = clampLabPage(page, first.total);
    got = page === 1 ? first : await fetchPage(page);
  }
  return { rows: got.rows, total: got.total, page, pageSize: LAB_PAGE_SIZE };
}

/** จับคู่คนไข้เอง (hn = null ยกเลิกการจับคู่) แล้วแจ้งคนไข้ทันทีถ้ายังไม่เคยแจ้งฉบับนี้ */
export async function matchLabResult(id: string, rawHn: string | null, staffId: string, now = Date.now()) {
  const r = await loadResult(id);
  if (!r) throw new LabError("ไม่พบผลแล็บ", 404);
  const db = supabaseAdmin();
  if (!rawHn?.trim()) {
    await db.from("lab_results").update({ patient_id: null, match_status: "unmatched", matched_by: staffId, matched_at: nowIso(), updated_at: nowIso() }).eq("id", id);
    return { matched: false as const, notify: null };
  }
  const hn = normalizeHn(rawHn);
  if (!hn) throw new LabError("HN ต้องเป็นตัวเลขไม่เกิน 9 หลัก");
  await upsertPatient({ hn });
  const already = (r.notified_version ?? 0) >= r.version_number && r.patient_id === hn;
  await db.from("lab_results").update({
    patient_id: hn, match_status: "manual", matched_by: staffId, matched_at: nowIso(), updated_at: nowIso(),
    ...(already ? {} : { notify_status: "pending" }),
  }).eq("id", id);
  const notify = already ? null : await notifyLabResult(id, { now });
  return { matched: true as const, notify };
}

/** เจ้าหน้าที่กด "ส่งแจ้งคนไข้" เอง (เช่น คนไข้เพิ่งผูก LINE หลังผลออก) */
export async function staffNotifyLabResult(id: string, now = Date.now()) {
  const r = await loadResult(id);
  if (!r) throw new LabError("ไม่พบผลแล็บ", 404);
  if (!r.patient_id) throw new LabError("ยังไม่ได้จับคู่คนไข้");
  return { notify: await notifyLabResult(id, { now }) };
}

/** HN ที่ขอ → แชทที่ผูก (query เดียวทุก HN) · key = HN ตามที่ส่งมา */
async function linkedConversationsByHn(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map(ids.map((h) => [h, [] as string[]]));
  if (!ids.length) return out;
  const { data } = await supabaseAdmin().from("patient_links").select("conversation_id, hn").in("hn", [...new Set(ids.flatMap(hnVariants))]);
  const byBare = new Map(ids.map((h) => [normalizeHn(h) ?? h, h]));
  for (const l of (data ?? []) as { conversation_id: string; hn: string }[]) {
    const key = byBare.get(normalizeHn(l.hn) ?? l.hn);
    if (key && !out.get(key)!.includes(l.conversation_id)) out.get(key)!.push(l.conversation_id);
  }
  return out;
}

/**
 * หน้าผลแล็บ: HN ไหนตอนนี้มี LINE ที่ส่งได้แล้ว (คนไข้ผูกทีหลัง → ขึ้น "ผูก LINE แล้ว · รอส่ง" ให้เจ้าหน้าที่กดส่ง)
 * 2 query รวดเดียวทุก HN (กติกาเดียวกับ lineTargetsOf: แชท LINE ที่มีผู้ติดต่อ ไม่บล็อก/เลิกติดตาม และไม่ถูกเก็บถาวร)
 */
export async function lineReadyHns(hns: (string | null)[]): Promise<Record<string, boolean>> {
  const ids = [...new Set(hns.filter((h): h is string => !!h))];
  const out: Record<string, boolean> = Object.fromEntries(ids.map((h) => [h, false]));
  if (!ids.length) return out;
  const byHn = await linkedConversationsByHn(ids);
  const convIds = [...new Set([...byHn.values()].flat())];
  if (!convIds.length) return out;
  const { data } = await supabaseAdmin().from("conversations")
    .select("id, archived, contacts(external_id, line_unfollowed_at), channels(type)").in("id", convIds);
  const ready = new Set(((data ?? []) as { id: string; archived?: boolean | null; contacts: unknown; channels: unknown }[]).filter((c) => {
    const contact = (Array.isArray(c.contacts) ? c.contacts[0] : c.contacts) as { external_id?: string; line_unfollowed_at?: string | null } | null;
    const channel = (Array.isArray(c.channels) ? c.channels[0] : c.channels) as { type?: string } | null;
    return channel?.type === "line" && !!contact?.external_id && !contact.line_unfollowed_at && !c.archived;
  }).map((c) => c.id));
  for (const [hn, convs] of byHn) out[hn] = convs.some((c) => ready.has(c));
  return out;
}

export async function labSyncStatus() {
  return getSetting<LabSyncState>(LAB_SYNC_STATE_KEY, {});
}

/** การ์ดสรุปหน้าผลแล็บ */
export async function labResultSummary(now = Date.now()): Promise<LabSummary> {
  const todayStart = new Date(Date.parse(`${bangkokToday(now)}T00:00:00+07:00`)).toISOString();
  const db = supabaseAdmin();
  // นับอย่างเดียว ไม่ดึงแถว (กติกาเดียวกับ labSummary)
  const head = { count: "exact" as const, head: true };
  const [today, unmatched, unviewed] = await Promise.all([
    db.from("lab_results").select("id", head).gte("created_at", todayStart).neq("notify_status", "skipped"),
    db.from("lab_results").select("id", head).eq("match_status", "unmatched"),
    db.from("lab_results").select("id", head).eq("notify_status", "sent").is("first_viewed_at", null),
  ]);
  return { today: today.count ?? 0, unmatched: unmatched.count ?? 0, unviewed: unviewed.count ?? 0 };
}

/** badge เมนูซ้าย: ผลที่รอจับคู่ */
export async function labUnmatchedCount(): Promise<number> {
  const { count, data } = await supabaseAdmin().from("lab_results").select("id", { count: "exact", head: true }).eq("match_status", "unmatched");
  return count ?? (data ?? []).length;
}

// ---------------------------------------------------------------------------
// คนไข้ขอนัดฟังผลจากการ์ดผลแล็บ (LIFF ?book=) → คำขอใน bookings ให้เจ้าหน้าที่กดลงนัด (flow "นัดที่ AI รับไว้" เดิม)
// ---------------------------------------------------------------------------
export interface PatientRequest { date: string; time: string; when: string }
const whenText = (date: string, time: string) => `วัน${thaiWeekday(date)}ที่ ${thaiDate(date)} เวลา ${thaiTime(time)} น.`;
const whenTextFor = (date: string, time: string, lang: PatientLang | null) => (lang === "en" ? `${englishDate(date)}, ${time}` : whenText(date, time));
const requestView = (q: HearingRequest | null, lang: PatientLang | null = "th"): PatientRequest | null =>
  (q ? { date: q.date, time: q.time, when: whenTextFor(q.date, q.time, lang) } : null);

/** คำขอนัดฟังผลที่ยังรอเจ้าหน้าที่ลงนัด ของ HN นี้ (ทุกแชทที่ผูก HN) */
async function pendingHearingRequest(hn: string, now = Date.now()): Promise<HearingRequest | null> {
  const convs = (await linkedConversationsOf(hn)).map((l) => l.conversation_id);
  if (!convs.length) return null;
  const { data } = await supabaseAdmin().from("bookings").select('id, conversation_id, "date", "time", created_at')
    .in("conversation_id", convs).eq("service", HEARING_SERVICE).eq("status", "ai_confirmed").gte("date", bangkokToday(now)).order("created_at", { ascending: false });
  const row = ((data ?? []) as { id: string; conversation_id: string; date: string; time: string }[])[0];
  return row ? { id: row.id, conversation_id: row.conversation_id, date: row.date, time: String(row.time).slice(0, 5) } : null;
}

/** หน้าเจ้าหน้าที่: คำขอนัดฟังผลที่รอยืนยันของแต่ละ HN (2 query รวดเดียวทุก HN · กติกาเดียวกับ pendingHearingRequest) */
export async function hearingRequestsByHn(hns: (string | null)[], now = Date.now()): Promise<Record<string, HearingRequest & { when: string }>> {
  const ids = [...new Set(hns.filter((h): h is string => !!h))];
  const out: Record<string, HearingRequest & { when: string }> = {};
  if (!ids.length) return out;
  const byHn = await linkedConversationsByHn(ids);
  const convIds = [...new Set([...byHn.values()].flat())];
  if (!convIds.length) return out;
  const { data } = await supabaseAdmin().from("bookings").select('id, conversation_id, "date", "time", created_at')
    .in("conversation_id", convIds).eq("service", HEARING_SERVICE).eq("status", "ai_confirmed").gte("date", bangkokToday(now)).order("created_at", { ascending: false });
  const rows = (data ?? []) as { id: string; conversation_id: string; date: string; time: string }[];
  for (const [hn, convs] of byHn) {
    const row = rows.find((b) => convs.includes(b.conversation_id));
    if (row) {
      const time = String(row.time).slice(0, 5);
      out[hn] = { id: row.id, conversation_id: row.conversation_id, date: row.date, time, when: whenText(row.date, time) };
    }
  }
  return out;
}

/** ผลนี้ + แชท LINE ของบัญชีนี้ที่ผูก HN ของผล (ไม่ใช่เจ้าของ = 404 ไม่บอกว่ามีผลอยู่) */
async function ownedResult(id: string, idToken: string) {
  const userId = await verifyLineIdToken(idToken);
  const r = await loadResult(id);
  if (!r || !r.patient_id) throw new LabError("ไม่พบผลแล็บนี้ในบัญชี LINE ของคุณ", 404);
  const { conversationIds } = await lineUserLinks(userId);
  const linked = new Set((await linkedConversationsOf(r.patient_id)).map((l) => l.conversation_id));
  const conversationId = conversationIds.find((c) => linked.has(c));
  if (!conversationId) throw new LabError("ไม่พบผลแล็บนี้ในบัญชี LINE ของคุณ", 404);
  return { r: r as LabResult & { patient_id: string }, conversationId, userId };
}

/** หน้าเลือกวันนัดฟังผล: วัน/เวลาที่เลือกได้ + นัดหรือคำขอที่มีอยู่แล้ว */
export async function patientBookingInfo(id: string, idToken: string, now = Date.now()) {
  const { r, userId } = await ownedResult(id, idToken);
  const [appointment, pending, hours, lang] = await Promise.all([hearingAppointment(r.patient_id, now), pendingHearingRequest(r.patient_id, now), loadBusinessHours(), lineUserLang(userId)]);
  return {
    patientName: r.patient_name, orderDate: r.order_datetime, lang,
    appointment: patientAppt(appointment, lang),
    request: appointment ? null : requestView(pending, lang),
    days: appointment ? [] : selfBookingDays(hours, now).map((d) => ({ ...d, label: lang === "en" ? dayButtonLabel(d.date, "en") : `${thaiWeekday(d.date)} ${thaiDate(d.date)}` })),
  };
}

/** คนไข้ส่งคำขอนัดฟังผล: มีคำขอค้างของ HN นี้ = อัปเดตอันเดิม · มีนัดจริงแล้ว = ไม่รับ */
export async function patientRequestAppointment(id: string, idToken: string, dateIn: unknown, timeIn: unknown, now = Date.now()) {
  const { r, conversationId, userId } = await ownedResult(id, idToken);
  const date = typeof dateIn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateIn) ? dateIn : "";
  const time = typeof timeIn === "string" && /^\d{2}:\d{2}$/.test(timeIn) ? timeIn : "";
  if (await hearingAppointment(r.patient_id, now)) throw new LabError("มีนัดฟังผลอยู่แล้ว ดูวันนัดได้ในหน้าผลแล็บ", 409);
  if (!date || !time || !selfBookingAllowed(date, time, await loadBusinessHours(), now)) {
    throw new LabError("เลือกวันเวลานี้ไม่ได้ (คลินิกปิดหรือเลยเวลาแล้ว) กรุณาเลือกใหม่", 400);
  }
  const db = supabaseAdmin();
  const at = new Date(now).toISOString();
  const existing = await pendingHearingRequest(r.patient_id, now);
  if (existing) {
    await db.from("bookings").update({ date, time, name: r.patient_name, updated_at: at }).eq("id", existing.id);
  } else {
    const { error } = await db.from("bookings").insert({
      conversation_id: conversationId, service: HEARING_SERVICE, date, time, name: r.patient_name, status: "ai_confirmed", created_at: at, updated_at: at,
    });
    if (error) throw error;
  }
  const when = whenText(date, time);
  const conv = existing?.conversation_id ?? conversationId;
  await db.from("messages").insert({
    conversation_id: conv, direction: "in", sender_type: "system", language: "th", external_id: null,
    body: `คนไข้ขอนัดฟังผล ${when} — รอเจ้าหน้าที่ลงนัด`,
  });
  // ให้แชทขึ้นมาให้เจ้าหน้าที่เห็น (เหมือนนัดที่ AI รับไว้)
  await db.from("conversations").update({ last_message_at: at, last_message_preview: `คนไข้ขอนัดฟังผล ${when}`.slice(0, 120) }).eq("id", conv);
  const lang = await lineUserLang(userId);
  // ข้อความในแชทของเจ้าหน้าที่เป็นไทยเสมอ · ที่คืนให้หน้าคนไข้ตามภาษาของบัญชี
  return { date, time, when: whenTextFor(date, time, lang), updated: !!existing, lang };
}
