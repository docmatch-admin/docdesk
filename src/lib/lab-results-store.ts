// ผลแล็บจากแล็บนอก: sync → เก็บ PDF ใน Storage (private) → จับคู่ HN → แจ้งคนไข้ทาง LINE + แจ้งทีมในกลุ่ม LINE
// ข้อมูลผลแล็บไม่ส่งเข้า AI: ไม่มีค่าผลในข้อความแชท ข้อความแจ้งเป็น sender_type 'system' ที่ suggest.ts ข้ามอยู่แล้ว
import { addDays, bangkokToday, OPEN_STATUSES } from "./appointment-rules";
import { BmlError, bmlEnabled, bmlLabPdf, bmlListLabs, type BmlLabItem } from "./bml-client";
import { lineSendMessages } from "./channels/line";
import { LineQuotaError } from "./channels/line-log";
import {
  isUpdateNotice, LAB_BUCKET, LAB_COLUMNS, LAB_SENDER_NAME, LAB_SIGNED_URL_SECONDS, LAB_SYNC_LOOKBACK_DAYS, LAB_SYNC_MAX_PAGES,
  LAB_SYNC_STATE_KEY, LAB_TEAM_GROUP_KEY, labHn, labViewUrl, inLabTab, patientNoticeFlex, patientNoticeText,
  resultHearingAppointment, shouldAutoNotify, syncAction, syncDue, teamNoticeText, versionOf,
  type LabAppointment, type LabResult, type LabSyncState, type LabTab,
} from "./lab-results-rules";
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
    order_datetime: item.order_datetime ?? null, status: item.status ?? null, bml_imported_at: item.imported_at ?? null,
  };
  // จับคู่อัตโนมัติ (ไม่แตะแถวที่เจ้าหน้าที่จับคู่เอง)
  let match: Partial<LabResult> = {};
  if (existing?.match_status !== "manual") {
    const hn = labHn(item.location_hn, item.location_hn_extraction_status);
    match = hn && (await patientExists(hn)) ? { patient_id: hn, match_status: "matched" } : { patient_id: null, match_status: "unmatched" };
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
      notify_status: opts.backfill ? "skipped" : "pending",
      ...(opts.backfill ? { team_notified_version: version } : {}),
      updated_at: nowIso(),
    }, { onConflict: "bml_id" }).select(LAB_COLUMNS);
    if (error) throw error;
    return { row: (data ?? [])[0] as unknown as LabResult, action: "new", pdfFailed, pdfTried: opts.allowPdf };
  }
  const { data, error } = await db.from("lab_results").update({
    ...base, ...match, ...pdf, version_number: version, updated_at: nowIso(),
    // แล็บแก้ผล: แจ้งคนไข้ใหม่ ("ผลมีการปรับปรุง")
    ...(versionBump && existing.notify_status !== "skipped" ? { notify_status: "pending" } : {}),
  }).eq("id", existing.id).select(LAB_COLUMNS);
  if (error) throw error;
  return { row: ((data ?? [])[0] as unknown as LabResult) ?? existing, action: versionBump ? "updated" : "same", pdfFailed, pdfTried: opts.allowPdf };
}

/** pg_cron ชั่วโมงละครั้ง 13:00–18:00 น. (→ /api/cron/lab-results) · เรียกซ้ำภายใน 15 นาทีข้ามโดยไม่เรียกระบบแล็บ
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
    let cursor: string | null = null;
    for (let page = 0; page < LAB_SYNC_MAX_PAGES; page++) {
      const res = await bmlListLabs(cursor);
      items.push(...res.items);
      const oldest = res.items.at(-1)?.order_datetime;
      if (!res.has_more || !res.next_cursor || res.next_cursor === cursor || (oldest && oldest < cutoff)) break;
      cursor = res.next_cursor;
    }
    summary.fetched = items.length;

    const touched: { row: LabResult; action: "new" | "updated" | "same" }[] = [];
    // route มีเวลา 60 วินาที: โหลด PDF ไม่เกิน LAB_PDF_PER_RUN ไฟล์และไม่เกิน ~35 วินาที ที่เหลือโหลดรอบถัดไป
    const started = Date.now();
    let pdfs = 0;
    for (const item of items) {
      if (item.order_datetime && item.order_datetime < cutoff && !backfill) continue;
      const allowPdf = pdfs < LAB_PDF_PER_RUN && Date.now() - started < 35_000;
      const r = await upsertItem(item, { backfill, allowPdf });
      if (r?.pdfTried) pdfs++;
      if (!r) continue;
      if (r.pdfFailed) summary.pdfFailed++;
      if (r.action === "new") summary.created++;
      if (r.action === "updated") summary.updated++;
      touched.push(r);
    }

    if (!backfill) {
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
interface LineTarget { conversationId: string; userId: string }

/** บัญชี LINE ที่ผูกกับ HN นี้: ส่งได้ / ส่งไม่ได้เพราะบล็อก·เลิกติดตาม OA หรือแชทถูกเก็บถาวร */
async function lineTargetsOf(hn: string): Promise<{ targets: LineTarget[]; blocked: string[] }> {
  const links = await linkedConversationsOf(hn);
  if (!links.length) return { targets: [], blocked: [] };
  const { data } = await supabaseAdmin().from("conversations")
    .select("id, archived, contacts(external_id, line_unfollowed_at), channels(type)")
    .in("id", links.map((l) => l.conversation_id));
  const out: LineTarget[] = [];
  const blocked: string[] = [];
  for (const c of (data ?? []) as { id: string; archived?: boolean | null; contacts: unknown; channels: unknown }[]) {
    const contact = (Array.isArray(c.contacts) ? c.contacts[0] : c.contacts) as { external_id?: string; line_unfollowed_at?: string | null } | null;
    const channel = (Array.isArray(c.channels) ? c.channels[0] : c.channels) as { type?: string } | null;
    if (channel?.type !== "line" || !contact?.external_id) continue;
    if (contact.line_unfollowed_at) { blocked.push("คนไข้บล็อกหรือเลิกติดตาม LINE OA"); continue; }
    if (c.archived) { blocked.push("แชท LINE นี้เป็นแชทนำเข้า (ส่งไม่ได้)"); continue; }
    out.push({ conversationId: c.id, userId: contact.external_id });
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
    .select("id, appoint_date, time_mode, time_start, time_end, status, purpose_text, telemed_id")
    .in("hn", hnVariants(hn)).in("status", OPEN_STATUSES).gte("appoint_date", today).lte("appoint_date", addDays(today, 120));
  return resultHearingAppointment((data ?? []) as unknown as LabAppointment[], today);
}

async function clinicName(): Promise<string> {
  const profile = await getSetting<{ name?: string }>("clinic_profile", DEFAULT_CLINIC_PROFILE);
  return profile?.name?.trim() || DEFAULT_CLINIC_PROFILE.name;
}

export type NotifyResult = { sent: true; accounts: number } | { sent: false; reason: "unmatched" | "no_pdf" | "unreachable" | "failed"; error?: string };

/** ส่ง "ผลแล็บของคุณออกแล้ว" (หรือ "มีการปรับปรุง") ไปทุกบัญชี LINE ที่ผูก HN — ไม่ส่งไฟล์ PDF ในแชท ส่งแค่ปุ่มเปิดผ่าน LIFF */
export async function notifyLabResult(id: string, opts: { now?: number } = {}): Promise<NotifyResult> {
  const now = opts.now ?? Date.now();
  const db = supabaseAdmin();
  const r = await loadResult(id);
  if (!r) throw new LabError("ไม่พบผลแล็บ", 404);
  if (!r.patient_id) return { sent: false, reason: "unmatched" };
  if (!r.pdf_path) return { sent: false, reason: "no_pdf" };
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
  const [clinic, appointment] = await Promise.all([clinicName(), hearingAppointment(r.patient_id, now)]);
  const updated = isUpdateNotice(r);
  let sent = 0;
  const errors: string[] = [...blocked];
  for (const t of targets) {
    const showName = (await linksOfConversation(t.conversationId)).length > 1;
    const notice = { clinic, patientName: r.patient_name, showName, updated, orderDate: r.order_datetime, viewUrl: labViewUrl(liffId(), appUrl(), r.id), appointment };
    try {
      await lineSendMessages(t.userId, [patientNoticeFlex(notice)], undefined, { kind: "lab", conversationId: t.conversationId });
      await db.from("messages").insert({
        conversation_id: t.conversationId, direction: "out", sender_type: "system", body: patientNoticeText(notice), language: "th",
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

async function signedPdfUrl(path: string): Promise<string> {
  const { data, error } = await supabaseAdmin().storage.from(LAB_BUCKET).createSignedUrls([path], LAB_SIGNED_URL_SECONDS);
  const url = (data ?? [])[0]?.signedUrl;
  if (error || !url) throw new LabError("เปิดไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง", 502);
  return url;
}

export async function patientViewLab(id: string, idToken: string) {
  const userId = await verifyLineIdToken(idToken);
  const r = await loadResult(id);
  // ไม่บอกว่ามีผลนี้อยู่หรือไม่ ถ้าไม่ใช่เจ้าของ
  if (!r || !r.patient_id || !r.pdf_path || !(await lineUserOwnsHn(userId, r.patient_id))) {
    throw new LabError("ไม่พบผลแล็บนี้ในบัญชี LINE ของคุณ", 404);
  }
  const url = await signedPdfUrl(r.pdf_path);
  const at = nowIso();
  await supabaseAdmin().from("lab_results").update({ view_count: (r.view_count ?? 0) + 1, first_viewed_at: r.first_viewed_at ?? at, last_viewed_at: at }).eq("id", r.id);
  return { url, expiresIn: LAB_SIGNED_URL_SECONDS, patientName: r.patient_name, orderDate: r.order_datetime, updated: r.version_number > 1 };
}

// ---------------------------------------------------------------------------
// หน้าเจ้าหน้าที่
// ---------------------------------------------------------------------------
export async function staffPdfUrl(id: string): Promise<string> {
  const r = await loadResult(id);
  if (!r?.pdf_path) throw new LabError("ยังไม่มีไฟล์ผลนี้", 404);
  return signedPdfUrl(r.pdf_path);
}

const LIST_LIMIT = 300;
const searchTerm = (q: string) => q.replace(/[,()%*\\:"']/g, " ").trim().slice(0, 60);

export async function listLabResults(opts: { tab?: LabTab; q?: string; id?: string | null; conversationId?: string | null } = {}): Promise<LabResult[]> {
  let qy = supabaseAdmin().from("lab_results").select(LAB_COLUMNS);
  if (opts.id) qy = qy.eq("id", opts.id);
  if (opts.conversationId) {
    const hns = [...new Set((await linksOfConversation(opts.conversationId)).map((l) => normalizeHn(l.hn)).filter((h): h is string => !!h))];
    if (!hns.length) return [];
    qy = qy.in("patient_id", hns);
  }
  const q = searchTerm(opts.q ?? "");
  if (q) {
    const hn = normalizeHn(q);
    qy = qy.or(`patient_name.ilike.%${q}%,ln.ilike.%${q}%,location_hn.ilike.%${q}%${hn ? `,patient_id.eq.${hn}` : ""}`);
  }
  const { data } = await qy.order("order_datetime", { ascending: false }).limit(LIST_LIMIT);
  const rows = (data ?? []) as unknown as LabResult[];
  return opts.tab ? rows.filter((r) => inLabTab(r, opts.tab!)) : rows;
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

export async function labSyncStatus() {
  return getSetting<LabSyncState>(LAB_SYNC_STATE_KEY, {});
}
