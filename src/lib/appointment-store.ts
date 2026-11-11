import {
  addDays, appointmentFlex, callQueue, frequentTexts, lineOaMessageUrl, appointmentText, bangkokToday, chooseDelivery, DELIVERY_FAILURE_TEXT, generateLinkCode,
  metaAppointmentMessage, normalizeAppointmentSettings, OPEN_STATUSES, parseDate, parseTime, parseAppointmentPostback, pickLanguage, REPLY_TEXT,
  reminderDecision, TEST_APPOINTMENT_ID, thaiShortDate, timeShort, weekdayOf,
  canRestore, CANCEL_REASON_LABEL, DELIVERY_SKIP_TEXT, type DeliverySkip, defaultSeriesLabel, notifiesOnCancel, shiftFollowing,
  type Appointment, type AppointmentSettings, type CancelReason, type ClinicSchedule, type ClinicSlot, type Lang, type MessageInput, type MessageKind,
} from "./appointment-rules";
import { sendPushToStaff } from "./booking-store";
import { lineSendMessages } from "./channels/line";
import { LinePushSkipped, LineQuotaError } from "./channels/line-log";
import { lineQuotaState } from "./line-quota";
import { claimReplyTokenWithAge } from "./channels/reply-token";
import { metaSendMessage } from "./channels/meta";
import { DEFAULT_CLINIC_PROFILE, getSetting } from "./mode";
import { SENSITIVE_TAG } from "./sensitive-rules";
import { slipSourceTexts, type SlipData } from "./appointment-slip";
import { saveSlipTranslation, translateSlipTexts, type SlipField } from "./slip-translate";
import { hnVariants, unlinkConversation, linkConversationToHn, linkedConversationsOf, linksOfConversation, rolesForHn, sameHn, upsertPatient, type PatientRelation } from "./patient-link-store";
import { cleanProviderName, providerOptions, type Provider } from "./providers";
import { patientContact } from "./patient-contact";
import { contactName, type ContactNameFields } from "./patient-name";
import { supabaseAdmin } from "./supabase/admin";
import type { ChannelType } from "./types";

/**
 * ระบบนัดครั้งต่อไป: ข้อความทุกข้อความที่ระบบนี้ส่งหรือรับเป็น sender_type 'system'
 * จึงไม่นับในคิวรอตอบ ไม่ทำให้แชทที่เสร็จแล้วเด้งกลับ และไม่ถูกส่งเข้า AI (suggest.ts ข้าม system)
 */
export const APPOINTMENT_SENDER_NAME = "ระบบนัด";

export const APPOINTMENT_COLUMNS = "id, hn, patient_name, phone, conversation_id, booking_id, appoint_date, time_mode, slot_id, time_start, time_end, purpose_id, purpose_text, instructions, provider, note, status, link_code, confirm_sent_at, reminder_sent_at, reminder_attempted_at, name_from_his, arrived_time, last_send_error, called_at, called_by, cancel_reason, cancel_reason_code, cancelled_by, cancelled_at, series_id, series_seq, series_label, series_from, series_offset_value, series_offset_unit, series_done, created_by, created_at, updated_at";

export const loadAppointmentSettings = async (): Promise<AppointmentSettings> =>
  normalizeAppointmentSettings(await getSetting<unknown>("appointment_settings", {}));

async function clinicName(): Promise<string> {
  const profile = await getSetting<{ name?: string }>("clinic_profile", DEFAULT_CLINIC_PROFILE);
  return profile?.name?.trim() || DEFAULT_CLINIC_PROFILE.name;
}

type Actor = "staff" | "customer" | "system";

export async function logAppointmentEvent(appointmentId: string, kind: string, actor: Actor, opts: { staffId?: string | null; channel?: string | null; detail?: Record<string, unknown> } = {}) {
  const { error } = await supabaseAdmin().from("appointment_events").insert({
    appointment_id: appointmentId, kind, actor, staff_id: opts.staffId ?? null, channel: opts.channel ?? null, detail: opts.detail ?? {},
  });
  if (error) console.error("appointment event failed", error.code);
}

const nowIso = () => new Date().toISOString();
const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ---------------------------------------------------------------------------
// แชทและคนไข้
// ---------------------------------------------------------------------------
interface ConversationInfo {
  id: string;
  channelType: ChannelType;
  externalId: string;
  displayName: string | null;
  language: string;
  sensitive: boolean;
  tags: string[];
  archived: boolean;
  status: string;
  lastInboundAt: string | null;
  /** LINE: เลิกติดตาม/บล็อก OA */
  unfollowed: boolean;
}

async function conversationInfo(conversationId: string): Promise<ConversationInfo | null> {
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations")
    .select("id, status, sensitive, tags, archived, contacts(external_id, display_name, language, line_unfollowed_at), channels(type)")
    .eq("id", conversationId).maybeSingle();
  if (!conv) return null;
  const contact = (Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts) as { external_id: string; display_name: string | null; language: string; line_unfollowed_at?: string | null } | null;
  const channel = (Array.isArray(conv.channels) ? conv.channels[0] : conv.channels) as { type: ChannelType } | null;
  if (!contact || !channel) return null;
  // นับทุกข้อความเข้า รวมการกดปุ่มของระบบนัด เพราะ Meta นับเป็นการทักเหมือนกัน
  const { data: lastIn } = await db.from("messages").select("created_at")
    .eq("conversation_id", conversationId).eq("direction", "in").order("created_at", { ascending: false }).limit(1).maybeSingle();
  return {
    id: conv.id as string,
    channelType: channel.type,
    externalId: contact.external_id,
    displayName: contact.display_name,
    language: contact.language || "th",
    sensitive: !!conv.sensitive,
    tags: (conv.tags ?? []) as string[],
    archived: !!conv.archived,
    status: conv.status as string,
    lastInboundAt: (lastIn?.created_at as string | undefined) ?? null,
    unfollowed: !!contact.line_unfollowed_at,
  };
}

/** แชทหลักของ HN นี้: บัญชีคนไข้ก่อนบัญชีญาติ ถ้าเท่ากันเอาที่ผูกล่าสุด */
export async function findLinkedConversation(hn: string | null | undefined): Promise<string | null> {
  const links = await linkedConversationsOf(hn);
  if (!links.length) return null;
  const ranked = [...links].sort((a, b) => Number(a.role === "relative") - Number(b.role === "relative") || b.linked_at.localeCompare(a.linked_at));
  return ranked[0].conversation_id;
}

/** ป้ายคนไข้/ญาติ ของแต่ละแชท (จาก contacts) */
async function relationsOf(conversationIds: string[]): Promise<Map<string, PatientRelation | null>> {
  const out = new Map<string, PatientRelation | null>();
  if (!conversationIds.length) return out;
  const { data } = await supabaseAdmin().from("conversations").select("id, contacts(patient_relation)").in("id", conversationIds);
  for (const r of (data ?? []) as { id: string; contacts: unknown }[]) {
    const c = (Array.isArray(r.contacts) ? r.contacts[0] : r.contacts) as { patient_relation?: string | null } | null;
    out.set(r.id, c?.patient_relation === "relative" ? "relative" : c?.patient_relation === "patient" ? "patient" : null);
  }
  return out;
}

/**
 * แชทที่รับข้อความของนัดนี้: แชทหลักของนัด + ทุกบัญชีที่ผูก HN (คนไข้และญาติ)
 * + บัญชีที่สแกน QR เพิ่ม (นัดที่ไม่มี HN เก็บใน appointment_recipients)
 */
export async function recipientIds(appt: Pick<Appointment, "id" | "hn" | "conversation_id">): Promise<string[]> {
  const ids: string[] = [];
  if (appt.conversation_id) ids.push(appt.conversation_id);
  for (const l of await linkedConversationsOf(appt.hn)) ids.push(l.conversation_id);
  const { data } = await supabaseAdmin().from("appointment_recipients").select("conversation_id, added_at").eq("appointment_id", appt.id);
  for (const r of (data ?? []) as { conversation_id: string }[]) ids.push(r.conversation_id);
  return [...new Set(ids)];
}

export interface LinkedAccount {
  conversation_id: string;
  channel: ChannelType | null;
  name: string | null;
  relation: PatientRelation;
  following: boolean;
  primary: boolean;
  /** hn = ผูกผ่าน HN (patient_links), code = สแกนรหัสของนัดที่ไม่มี HN */
  via: "hn" | "code";
}

/** บัญชีที่รับข้อความของนัดนี้ สำหรับ drawer */
export async function linkedAccounts(appt: Pick<Appointment, "id" | "hn" | "conversation_id">): Promise<LinkedAccount[]> {
  const ids = await recipientIds(appt);
  const viaHn = new Set((await linkedConversationsOf(appt.hn)).map((l) => l.conversation_id));
  const byHn = await rolesForHn(appt.hn, ids);
  const byContact = await relationsOf(ids);
  const rel = new Map(ids.map((id) => [id, byHn.get(id) ?? byContact.get(id) ?? null]));
  const out: LinkedAccount[] = [];
  for (const id of ids) {
    const info = await conversationInfo(id);
    out.push({
      conversation_id: id, channel: info?.channelType ?? null, name: info?.displayName ?? null,
      relation: rel.get(id) ?? (id === appt.conversation_id ? "patient" : "relative"),
      following: !!info && !info.unfollowed && !info.archived,
      primary: id === appt.conversation_id, via: viaHn.has(id) ? "hn" : "code",
    });
  }
  return out;
}

/** สร้างรายชื่อและแชทถ้ายังไม่มี ไม่เปลี่ยนสถานะแชท ใช้กับข้อความของระบบนัดเท่านั้น */
export async function ensureConversation(channelType: ChannelType, externalId: string, displayName?: string, avatarUrl?: string): Promise<string> {
  const db = supabaseAdmin();
  const { data: channel } = await db.from("channels").select("id").eq("type", channelType).eq("enabled", true)
    .order("created_at").limit(1).maybeSingle();
  if (!channel) throw new Error(`ไม่พบช่องทาง ${channelType} ที่เปิดใช้งาน`);
  let { data: contact } = await db.from("contacts").select("id")
    .eq("channel_id", channel.id).eq("external_id", externalId).maybeSingle();
  if (!contact) {
    const { data, error } = await db.from("contacts").insert({
      channel_id: channel.id, external_id: externalId, display_name: displayName ?? null, platform_name: displayName ?? null, avatar_url: avatarUrl ?? null,
    }).select("id").single();
    if (error || !data) throw error ?? new Error("contact insert failed");
    contact = data;
  }
  const { data: existing } = await db.from("conversations").select("id").eq("contact_id", contact.id).maybeSingle();
  if (existing) return existing.id as string;
  const { data: conv, error } = await db.from("conversations")
    .upsert({ contact_id: contact.id, channel_id: channel.id }, { onConflict: "contact_id" }).select("id").single();
  if (error || !conv) throw error ?? new Error("conversation upsert failed");
  return conv.id as string;
}

async function insertSystemMessage(conversationId: string, m: { direction: "in" | "out"; body: string; language: string; externalId?: string | null; label?: string }) {
  const { error } = await supabaseAdmin().from("messages").insert({
    conversation_id: conversationId,
    direction: m.direction,
    sender_type: "system",
    body: m.body,
    language: m.language,
    external_id: m.externalId ?? null,
    imported_sender_name: m.direction === "out" ? (m.label ?? APPOINTMENT_SENDER_NAME) : null,
  });
  // ชนกับ external_id เดิม = webhook ซ้ำ บันทึกไปแล้ว
  if (error && error.code !== "23505") throw error;
}

async function alreadyHandled(externalId: string): Promise<boolean> {
  const { data } = await supabaseAdmin().from("messages").select("id").eq("external_id", externalId).maybeSingle();
  return !!data;
}

// ---------------------------------------------------------------------------
// ส่งข้อความนัด
// ---------------------------------------------------------------------------
export interface DeliveryResult { sent: boolean; via?: ChannelType; error?: string; /** ส่งถึงกี่บัญชี (มากกว่า 1) */ accounts?: number; /** งดส่งทันทีโดยตั้งใจ (ไม่ใช่ส่งไม่ได้) */ skipped?: boolean }

function messageInput(appt: MessageInput["appointment"], kind: MessageKind, info: ConversationInfo, settings: AppointmentSettings, clinic: string): MessageInput {
  return {
    kind,
    lang: pickLanguage(info.language),
    appointment: appt,
    settings,
    clinicName: clinic,
    includePurpose: settings.send_purpose_in_message && !info.sensitive && !info.tags.includes(SENSITIVE_TAG),
  };
}

/** ส่งตามช่องทาง คืน mid ของ Meta ไว้กัน echo ซ้ำ */
async function pushAppointment(info: ConversationInfo, via: "line" | "facebook" | "instagram", input: MessageInput, replyToken?: string, replyOnly = false): Promise<string | null> {
  if (via === "line") {
    // ไม่มี token จาก event (กดปุ่ม/ส่งรหัส) ใช้ token ล่าสุดของแชทถ้ายังไม่ถูกใช้ ไม่งั้น push
    const claimed = replyToken ? undefined : await claimReplyTokenWithAge(supabaseAdmin(), info.id);
    await lineSendMessages(info.externalId, [appointmentFlex(input)], replyToken ?? claimed?.token, {
      kind: input.kind === "reminder" ? "reminder" : "appointment", conversationId: info.id, tokenAgeMs: claimed?.ageMs ?? (replyToken ? 0 : null), replyOnly,
    });
    return null;
  }
  return metaSendMessage(info.externalId, metaAppointmentMessage(via, input));
}

/**
 * ส่งข้อความนัดหนึ่งครั้ง บันทึกผลลง appointments และ appointment_events
 * ส่งไม่ได้ (นอก 24 ชม., ไม่มีแชท) บันทึกเป็น "ส่งไม่ได้-ต้องโทร" ไม่ throw
 */
export async function deliverAppointment(appt: Appointment, kind: MessageKind, opts: {
  actor?: Actor; staffId?: string | null; replyToken?: string; now?: number; previous?: MessageInput["previous"];
  series?: MessageInput["series"]; seriesPosition?: MessageInput["seriesPosition"];
  /** นัดอื่นในชุดที่ได้ข้อความเดียวกัน (การ์ดชุดนัด) */
  alsoMark?: string[];
  /** ส่งเฉพาะแชทนี้ (ตอบคนที่เพิ่งสแกน QR) ไม่งั้นส่งทุกบัญชีที่ผูก */
  only?: string;
} = {}): Promise<DeliveryResult> {
  const db = supabaseAdmin();
  const actor = opts.actor ?? "system";
  const targets = opts.only ? [opts.only] : await recipientIds(appt);
  if (!targets.length) {
    await logAppointmentEvent(appt.id, "send_skipped", actor, { staffId: opts.staffId, detail: { kind, reason: "no_chat" } });
    return { sent: false, error: DELIVERY_FAILURE_TEXT.no_chat };
  }
  const [settings, clinic] = await Promise.all([loadAppointmentSettings(), clinicName()]);
  // LINE push สำหรับลงนัด/เปลี่ยนนัด: ปิดส่งทันที (เฉพาะลงนัด) หรือโควตาเหลือน้อยกว่า 10% → ส่งได้เฉพาะ reply
  // เก็บโควตาไว้ให้ข้อความเตือนก่อนวันนัด
  let pushSkip: DeliverySkip | null = null;
  if (kind === "new" && !settings.send_on_create) pushSkip = "send_on_create_off";
  else if (kind === "new" || kind === "changed") {
    const q = await lineQuotaState().catch(() => null);
    if (q && (q.level === "low" || q.level === "out")) pushSkip = "quota_low";
  }
  const sent: { id: string; via: ChannelType }[] = [];
  const failed: { id: string; via?: ChannelType; reason?: string; error: string }[] = [];
  const skipped: { id: string; reason: DeliverySkip }[] = [];
  for (const target of targets) {
    const info = await conversationInfo(target);
    const delivery = chooseDelivery({ channelType: info?.channelType ?? null, lastInboundAt: info?.lastInboundAt ?? null, archived: info?.archived, unfollowed: info?.unfollowed, now: opts.now });
    if (!info || !delivery.ok) {
      const reason = delivery.ok ? "no_chat" : delivery.reason;
      failed.push({ id: target, via: info?.channelType, reason, error: DELIVERY_FAILURE_TEXT[reason] });
      continue;
    }
    // บัญชีนี้เกี่ยวกับมากกว่า 1 HN (รวม HN ของนัดนี้ที่อาจกำลังจะผูก): ระบุชื่อคนที่นัด
    const multiHn = new Set([...(await linksOfConversation(target)).map((l) => l.hn.replace(/^0+/, "")), ...(appt.hn ? [appt.hn.trim().replace(/^0+/, "")] : [])]).size > 1;
    const input = { ...messageInput(appt, kind, info, settings, clinic), previous: opts.previous, series: opts.series, seriesPosition: opts.seriesPosition, ...(multiHn ? { forPatient: appt.patient_name } : {}) };
    try {
      // replyToken ใช้ได้กับแชทที่ส่ง event มาเท่านั้น
      const mid = await pushAppointment(info, delivery.via, input, opts.only === target ? opts.replyToken : undefined, delivery.via === "line" && !!pushSkip);
      await insertSystemMessage(info.id, { direction: "out", body: appointmentText(input), language: input.lang, externalId: mid });
      sent.push({ id: target, via: delivery.via });
    } catch (e) {
      if (e instanceof LinePushSkipped && pushSkip) { skipped.push({ id: target, reason: pushSkip }); continue; }
      console.error("appointment send failed", delivery.via, kind);
      // โควตาหมด: ไม่ลองซ้ำ เข้ารายการต้องโทร
      if (e instanceof LineQuotaError) { failed.push({ id: target, via: delivery.via, reason: "quota", error: DELIVERY_FAILURE_TEXT.quota }); continue; }
      failed.push({ id: target, via: delivery.via, error: `ส่งไม่สำเร็จ-ต้องโทร: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` });
    }
  }
  const multi = targets.length > 1;
  for (const f of failed) {
    await logAppointmentEvent(appt.id, "send_failed", actor, {
      staffId: opts.staffId, channel: f.via ?? null,
      detail: { kind, ...(f.reason ? { reason: f.reason } : { error: f.error }), ...(multi ? { conversation_id: f.id } : {}) },
    });
  }
  for (const s of skipped) {
    await logAppointmentEvent(appt.id, "send_skipped", actor, { staffId: opts.staffId, channel: "line", detail: { kind, reason: s.reason, ...(multi ? { conversation_id: s.id } : {}) } });
  }
  if (!sent.length && skipped.length && !failed.some((f) => f.reason === "quota")) {
    // งดส่งทันทีโดยตั้งใจ: ไม่ใช่ส่งไม่ได้ ไม่เข้ารายการต้องโทร ยังมีเตือนก่อนวันนัด
    return { sent: false, via: "line", error: DELIVERY_SKIP_TEXT[skipped[0].reason], skipped: true };
  }
  if (!sent.length) {
    // ไม่มีบัญชีไหนได้รับ: แจ้งเหตุผลของแชทหลัก ทีมต้องโทร (โควตาหมดมาก่อน)
    const error = failed.find((f) => f.reason === "quota")?.error ?? failed[0]?.error ?? DELIVERY_FAILURE_TEXT.no_chat;
    await db.from("appointments").update({ last_send_error: error, updated_at: nowIso() }).eq("id", appt.id);
    return { sent: false, via: failed[0]?.via, error };
  }
  const at = nowIso();
  const sentField = kind === "reminder" ? { reminder_sent_at: at } : kind === "cancelled" ? {} : { confirm_sent_at: at };
  await db.from("appointments").update({ ...sentField, last_send_error: null, updated_at: at }).eq("id", appt.id);
  for (const s of sent) {
    await logAppointmentEvent(appt.id, "sent", actor, { staffId: opts.staffId, channel: s.via, detail: { kind, ...(opts.series ? { series: opts.series.length } : {}), ...(multi ? { conversation_id: s.id } : {}) } });
  }
  if (opts.alsoMark?.length) {
    await db.from("appointments").update({ ...sentField, last_send_error: null, updated_at: at }).in("id", opts.alsoMark);
    for (const id of opts.alsoMark) await logAppointmentEvent(id, "sent", actor, { staffId: opts.staffId, channel: sent[0].via, detail: { kind, via_series: appt.id } });
  }
  return { sent: true, via: sent[0].via, ...(sent.length > 1 ? { accounts: sent.length } : {}) };
}

// ---------------------------------------------------------------------------
// ชุดนัด
// ---------------------------------------------------------------------------
export async function loadSeries(seriesId: string): Promise<Appointment[]> {
  const { data } = await supabaseAdmin().from("appointments").select(APPOINTMENT_COLUMNS).eq("series_id", seriesId);
  return ((data ?? []) as unknown as Appointment[]).sort((a, b) => (a.series_seq ?? 0) - (b.series_seq ?? 0));
}

const seriesView = (items: Appointment[]): NonNullable<MessageInput["series"]> =>
  items.filter((a) => a.status !== "cancelled").map((a) => ({
    label: a.series_label || defaultSeriesLabel(a.series_seq ?? 1),
    appoint_date: a.appoint_date, time_mode: a.time_mode, time_start: a.time_start, time_end: a.time_end, done: !!a.series_done,
  }));

/** เข็ม N จาก M (นับเฉพาะนัดที่ไม่ได้ยกเลิก) */
async function seriesPosition(a: Appointment): Promise<MessageInput["seriesPosition"]> {
  if (!a.series_id) return undefined;
  const active = (await loadSeries(a.series_id)).filter((x) => x.status !== "cancelled");
  if (!active.some((x) => x.id === a.id)) return undefined;
  const seq = a.series_seq ?? 1;
  const total = Math.max(seq, ...active.map((x) => x.series_seq ?? 0));
  return { label: a.series_label || defaultSeriesLabel(seq), seq, total };
}

/** ข้อความตอบสั้นๆ หลังกดปุ่มหรือส่งรหัส ใช้ replyToken ของ LINE ก่อนเพื่อไม่กินโควตา */
async function replyText(info: ConversationInfo, text: string, replyToken?: string) {
  if (info.channelType === "line") {
    await lineSendMessages(info.externalId, [{ type: "text", text }], replyToken, { kind: "appointment", conversationId: info.id, tokenAgeMs: replyToken ? 0 : null });
    await insertSystemMessage(info.id, { direction: "out", body: text, language: pickLanguage(info.language) });
  } else if (info.channelType === "facebook" || info.channelType === "instagram") {
    const mid = await metaSendMessage(info.externalId, { text });
    await insertSystemMessage(info.id, { direction: "out", body: text, language: pickLanguage(info.language), externalId: mid });
  }
}

// ---------------------------------------------------------------------------
// สร้าง แก้ ยกเลิก
// ---------------------------------------------------------------------------
export interface AppointmentInput {
  hn?: unknown; patient_name?: unknown; phone?: unknown; appoint_date?: unknown;
  /** slot: ส่ง slot_id ระบบหาเวลาเริ่ม-สิ้นสุดจาก clinic_hours เอง / exact: ส่ง time_start */
  time_mode?: unknown; slot_id?: unknown; time_start?: unknown;
  purpose_id?: unknown; purpose_text?: unknown; instructions?: unknown;
  provider?: unknown; note?: unknown; conversation_id?: unknown; booking_id?: unknown;
  /** ชื่อมาจาก iService และไม่ได้แก้ */
  name_from_his?: unknown;
  /** ชุดนัด: นัดแรกคือฟิลด์หลัก นัดถัดไปอยู่ใน series_items */
  series_title?: unknown; series_label?: unknown;
  series_items?: unknown;
  /** เลขเข็มของนัดแรกที่สร้าง (วันนี้ฉีดเข็ม N → N+1) */
  series_start_seq?: unknown;
  /** เข็มที่ฉีดแล้ว [{seq, date}] */
  series_done?: unknown;
  /** แก้วันนัดในชุด: เลื่อนนัดถัดไปตามด้วย */
  shift_following?: unknown;
}

export class AppointmentError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PurposeRow { id: string; name: string; default_days: number | null; reminder_extra_text: string | null; sort_order: number; active: boolean }

/** เวลาเปิดคลินิกและวันหยุดพิเศษ ตั้งค่าที่หน้าตั้งค่า → นัดหมาย */
export async function loadClinicSchedule(from?: string, to?: string): Promise<ClinicSchedule> {
  const db = supabaseAdmin();
  let closuresQ = db.from("clinic_closures").select("closed_on, reason");
  if (from) closuresQ = closuresQ.gte("closed_on", from);
  if (to) closuresQ = closuresQ.lte("closed_on", to);
  const [{ data: hours }, { data: closures }] = await Promise.all([
    db.from("clinic_hours").select("weekday, slot_id, label, start_time, end_time, sort_order"),
    closuresQ,
  ]);
  const out: ClinicSchedule = { hours: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }, closures: {} };
  for (const h of (hours ?? []) as { weekday: number; slot_id: string; label: string; start_time: string; end_time: string }[]) {
    out.hours[h.weekday]?.push({ slot_id: h.slot_id, label: h.label, start: h.start_time.slice(0, 5), end: h.end_time.slice(0, 5) });
  }
  for (const d of Object.keys(out.hours)) out.hours[Number(d)].sort((a, b) => a.start.localeCompare(b.start));
  for (const c of (closures ?? []) as { closed_on: string; reason: string | null }[]) out.closures[c.closed_on] = c.reason ?? "";
  return out;
}

async function resolveFields(b: AppointmentInput, today: string) {
  const patient_name = clip(b.patient_name, 200);
  if (!patient_name) throw new AppointmentError("ต้องมีชื่อคนไข้");
  const appoint_date = parseDate(b.appoint_date);
  if (!appoint_date) throw new AppointmentError("วันที่ไม่ถูกต้อง");
  if (appoint_date < today) throw new AppointmentError("วันนัดผ่านไปแล้ว");

  // ช่วงเวลาอ่านจาก clinic_hours เสมอ ไม่เชื่อเวลาจากหน้าเว็บ
  let time: { time_mode: "slot" | "exact"; slot_id: string | null; time_start: string; time_end: string | null };
  if (b.time_mode === "slot") {
    const slotId = clip(b.slot_id, 30);
    const schedule = await loadClinicSchedule(appoint_date, appoint_date);
    const slot: ClinicSlot | undefined = (schedule.hours[weekdayOf(appoint_date)] ?? []).find((s) => s.slot_id === slotId);
    if (!slot) throw new AppointmentError("วันนั้นไม่มีช่วงเวลานี้ เลือกช่วงใหม่หรือระบุเวลา");
    time = { time_mode: "slot", slot_id: slot.slot_id, time_start: slot.start, time_end: slot.end };
  } else {
    const start = parseTime(b.time_start);
    if (!start) throw new AppointmentError("เวลาไม่ถูกต้อง");
    time = { time_mode: "exact", slot_id: null, time_start: start, time_end: null };
  }

  let purpose_id: string | null = null;
  let purpose_text = clip(b.purpose_text, 300) || null;
  const pid = clip(b.purpose_id, 64);
  if (pid) {
    if (!UUID.test(pid)) throw new AppointmentError("เหตุผลนัดไม่ถูกต้อง");
    const { data: preset } = await supabaseAdmin().from("appointment_purposes").select("id, name").eq("id", pid).maybeSingle();
    if (!preset) throw new AppointmentError("ไม่พบเหตุผลนัดนี้");
    purpose_id = preset.id as string;
    purpose_text ??= preset.name as string;
  }
  return {
    hn: clip(b.hn, 30) || null,
    patient_name,
    phone: clip(b.phone, 30) || null,
    appoint_date,
    ...time,
    purpose_id,
    purpose_text,
    instructions: clip(b.instructions, 1000) || null,
    // ผู้นัดว่างได้ (— ไม่ระบุ —) · ยุบช่องว่างซ้อน
    provider: cleanProviderName(b.provider) || null,
    note: clip(b.note, 1000) || null,
  };
}

/** ชื่อผู้นัดที่บันทึกในนัด → ตาราง providers (ยืดอายุไม่ให้ถูกซ่อน) · ล้มเหลวไม่กระทบการบันทึกนัด */
async function touchProvider(name: unknown) {
  const clean = cleanProviderName(name);
  if (!clean) return;
  const { error } = await supabaseAdmin().rpc("touch_providers", { p_names: [clean] });
  if (error) console.error("touch provider failed", error.code);
}

async function loadAppointment(id: string): Promise<Appointment | null> {
  const { data } = await supabaseAdmin().from("appointments").select(APPOINTMENT_COLUMNS).eq("id", id).maybeSingle();
  return (data as unknown as Appointment | null) ?? null;
}

/** รหัสสุ่มซ้ำได้ยากมาก แต่ unique index กันไว้ ชนแล้วสุ่มใหม่ */
async function insertWithCode(row: Record<string, unknown>): Promise<Appointment> {
  const db = supabaseAdmin();
  for (let i = 0; i < 5; i++) {
    const { data, error } = await db.from("appointments").insert({ ...row, link_code: generateLinkCode() }).select(APPOINTMENT_COLUMNS).single();
    if (!error && data) {
      await touchProvider(row.provider);
      return data as unknown as Appointment;
    }
    if (error?.code !== "23505") throw error ?? new Error("insert failed");
  }
  throw new Error("สร้างรหัสนัดไม่สำเร็จ");
}

/**
 * ลงนัด: จากหน้านัดหมาย (ไม่มีแชท) หรือจากกล่องขวาของแชท
 * ถ้า HN ผูกกับแชทแล้ว หรือทำนัดจากแชท ส่งข้อความนัดทันที booking_id = แปลงนัดที่ AI รับไว้เป็นนัดจริง
 */
/** canLink = ผู้ทำนัดเป็นแอดมิน ทำนัดจากแชทพร้อม HN ถือเป็นการยืนยันการจับคู่ */
export async function createAppointment(b: AppointmentInput, staffId: string, opts: { canLink?: boolean } = {}, now = Date.now()): Promise<{ appointment: Appointment; delivery: DeliveryResult }> {
  const db = supabaseAdmin();
  const fields = await resolveFields(b, bangkokToday(now));
  const fromChat = clip(b.conversation_id, 64) || null;
  const bookingId = clip(b.booking_id, 64) || null;

  if (bookingId) {
    const { data: booking } = await db.from("bookings").select("id, conversation_id, status").eq("id", bookingId).maybeSingle();
    if (!booking || booking.status === "cancelled") throw new AppointmentError("ไม่พบนัดที่ AI รับไว้", 404);
    if (fromChat && booking.conversation_id !== fromChat) throw new AppointmentError("นัดนี้อยู่คนละแชท");
  }
  if (fromChat) {
    const { data: conv } = await db.from("conversations").select("id").eq("id", fromChat).maybeSingle();
    if (!conv) throw new AppointmentError("ไม่พบแชท", 404);
  }
  const conversationId = fromChat ?? (await findLinkedConversation(fields.hn));

  // นัดถัดไปในชุด ตรวจครบก่อนบันทึกอะไร
  const rawItems = Array.isArray(b.series_items) ? (b.series_items as Record<string, unknown>[]).slice(0, 20) : [];
  const startSeq = Number.isInteger(b.series_start_seq) ? Math.max(1, Math.min(40, b.series_start_seq as number)) : 1;
  // เข็มที่ฉีดแล้ว: วันที่ต้องไม่เกินวันนี้ เลขเข็มน้อยกว่านัดแรก
  const doneRaw = Array.isArray(b.series_done) ? (b.series_done as Record<string, unknown>[]).slice(0, 20) : [];
  const done = doneRaw.map((d) => ({ seq: Number(d.seq), date: parseDate(d.date) }))
    .filter((d): d is { seq: number; date: string } => Number.isInteger(d.seq) && d.seq >= 1 && d.seq < startSeq && !!d.date && d.date <= bangkokToday(now));
  const followers = [];
  for (const [i, item] of rawItems.entries()) {
    const f = await resolveFields({ ...b, appoint_date: item.appoint_date, time_mode: item.time_mode, slot_id: item.slot_id, time_start: item.time_start }, bangkokToday(now))
      .catch((e) => { throw new AppointmentError(`นัดที่ ${i + 2}: ${e instanceof Error ? e.message : e}`); });
    const from = item.from === "first" || item.from === "previous" ? item.from : null;
    const unit = item.offset_unit === "day" || item.offset_unit === "week" || item.offset_unit === "month" ? item.offset_unit : null;
    const value = Number.isInteger(item.offset_value) ? Math.max(0, Math.min(3650, item.offset_value as number)) : null;
    const seq = startSeq + i + 1;
    followers.push({ ...f, series_seq: seq, series_label: clip(item.label, 50) || defaultSeriesLabel(seq), series_from: from, series_offset_value: value, series_offset_unit: unit });
  }
  let seriesId: string | null = null;
  if (followers.length || done.length || startSeq > 1) {
    const { data: series, error: sErr } = await db.from("appointment_series").insert({
      hn: fields.hn, conversation_id: conversationId, title: clip(b.series_title, 200) || fields.purpose_text, created_by: staffId,
    }).select("id").single();
    if (sErr || !series) throw sErr ?? new Error("สร้างชุดนัดไม่สำเร็จ");
    seriesId = series.id as string;
  }

  const common = { name_from_his: b.name_from_his === true, source: "docdesk", conversation_id: conversationId, status: "scheduled", created_by: staffId, updated_at: nowIso() };
  const appointment = await insertWithCode({
    ...fields, ...common, booking_id: bookingId,
    ...(seriesId ? { series_id: seriesId, series_seq: startSeq, series_label: clip(b.series_label, 50) || defaultSeriesLabel(startSeq) } : {}),
  });
  // เข็มที่ฉีดแล้ว: รายการในชุด ไม่ใช่นัด
  for (const d of done) {
    const row = await insertWithCode({
      ...fields, ...common, appoint_date: d.date, time_mode: "exact", slot_id: null, time_start: "00:00", time_end: null,
      status: "attended", series_id: seriesId, series_seq: d.seq, series_label: defaultSeriesLabel(d.seq), series_done: true,
    });
    await logAppointmentEvent(row.id, "dose_recorded", "staff", { staffId, detail: { series_seq: d.seq, date: d.date } });
  }
  await logAppointmentEvent(appointment.id, "created", "staff", { staffId, detail: { from: fromChat ? "chat" : "appointments", booking_id: bookingId, ...(seriesId ? { series: followers.length + 1 } : {}) } });
  const followerIds: string[] = [];
  for (const f of followers) {
    const row = await insertWithCode({ ...f, ...common, series_id: seriesId });
    followerIds.push(row.id);
    await logAppointmentEvent(row.id, "created", "staff", { staffId, detail: { from: "series", series_seq: f.series_seq } });
  }

  if (fromChat && fields.hn && opts.canLink) {
    await linkConversationToHn(fromChat, fields.hn, { via: "staff", staffId, fallbackName: fields.patient_name, fallbackFromHis: b.name_from_his === true, phone: fields.phone })
      .catch((e) => console.error("link hn failed", e));
  }
  if (bookingId) {
    // ปลดป้าย "ลงนัดก่อน" trigger ของ bookings คำนวณ booking_pending ใหม่
    const at = nowIso();
    const { data: recorded } = await db.from("bookings").update({ status: "recorded", recorded_at: at, recorded_by: staffId, updated_at: at })
      .eq("id", bookingId).eq("status", "ai_confirmed").select("conversation_id");
    const conv = (recorded?.[0]?.conversation_id as string | undefined) ?? null;
    if (conv) await db.rpc("set_conversation_tag", { p_conversation: conv, p_tag: "นัดแล้ว", p_action: "add", p_by: "staff" });
  }

  await upsertPatient({ hn: fields.hn, full_name: fields.patient_name, phone: fields.phone });
  // ชุดนัด: การ์ดเดียวแสดงทุกนัด ปุ่มยืนยันเป็นของนัดแรก
  const delivery = seriesId
    ? await deliverAppointment(appointment, "new", { actor: "staff", staffId, now, series: seriesView(await loadSeries(seriesId)), alsoMark: followerIds })
    : await deliverAppointment(appointment, "new", { actor: "staff", staffId, now });
  return { appointment: (await loadAppointment(appointment.id)) ?? appointment, delivery };
}

/** แก้วันหรือเวลา = ส่งข้อความนัดใหม่อัตโนมัติ และเริ่มรอบเตือนใหม่ */
/**
 * แก้นัด link_code คงเดิม
 * เปลี่ยนวัน/เวลา: กลับเป็น scheduled เตือนใหม่ตามวันใหม่ ส่งข้อความ "เปลี่ยนนัด" (วันเดิม → วันใหม่) และปิดงาน "เลื่อนนัด" ในแชท
 * แก้เหตุผล/หมายเหตุอย่างเดียว: ไม่ส่งข้อความ
 */
export async function updateAppointment(id: string, b: AppointmentInput, staffId: string, now = Date.now()): Promise<{ appointment: Appointment; delivery: DeliveryResult | null; moved: boolean; shifted: number }> {
  // สำเนาค่าก่อนแก้ ใช้หลังบันทึก (สถานะเดิม วันเวลาเดิม)
  const loaded = await loadAppointment(id);
  const current = loaded ? { ...loaded } : null;
  if (!current) throw new AppointmentError("ไม่พบนัด", 404);
  if (!OPEN_STATUSES.includes(current.status)) throw new AppointmentError("นัดนี้มาแล้ว ไม่มา หรือยกเลิกแล้ว แก้ไม่ได้", 409);
  const fields = await resolveFields({
    hn: current.hn, patient_name: current.patient_name, phone: current.phone, appoint_date: current.appoint_date,
    time_mode: current.time_mode, slot_id: current.slot_id, time_start: current.time_start.slice(0, 5),
    purpose_id: current.purpose_id, purpose_text: current.purpose_text, instructions: current.instructions,
    provider: current.provider, note: current.note,
    ...Object.fromEntries(Object.entries(b).filter(([k, v]) => v !== undefined && !["shift_following", "series_items", "series_title", "series_label"].includes(k))),
  }, bangkokToday(now));
  const when = (a: { appoint_date: string; time_mode: string; time_start: string; time_end: string | null }) =>
    `${a.appoint_date} ${a.time_mode} ${a.time_start.slice(0, 5)}-${a.time_end?.slice(0, 5) ?? ""}`;
  const moved = when(fields) !== when(current);
  const patch: Record<string, unknown> = { ...fields, updated_at: nowIso() };
  // แก้ชื่อเองแล้ว ไม่ใช่ชื่อจาก iService
  if (fields.patient_name !== current.patient_name) patch.name_from_his = false;
  if (moved) Object.assign(patch, { status: "scheduled", reminder_sent_at: null, reminder_attempted_at: null, called_at: null, called_by: null });
  const { error } = await supabaseAdmin().from("appointments").update(patch).eq("id", id);
  if (error) throw error;
  if (fields.provider !== current.provider) await touchProvider(fields.provider);
  if (fields.hn) await upsertPatient({ hn: fields.hn, full_name: fields.patient_name, phone: fields.phone });
  await logAppointmentEvent(id, moved ? "rescheduled" : "edited", "staff", {
    staffId, detail: moved ? { from: `${current.appoint_date} ${timeShort(current)}`, to: `${fields.appoint_date} ${timeShort(fields)}` } : {},
  });
  const updated = (await loadAppointment(id)) as Appointment;
  if (moved && current.status === "reschedule_requested" && current.conversation_id) await closeRescheduleTasks(current.conversation_id, staffId);
  let shifted = 0;
  if (moved && current.series_id && b.shift_following === true && fields.appoint_date !== current.appoint_date) {
    shifted = await shiftSeriesFollowers(current.series_id, current.series_seq ?? 1, fields.appoint_date, staffId);
  }
  const series = current.series_id ? seriesView(await loadSeries(current.series_id)) : undefined;
  const delivery = moved ? await deliverAppointment(updated, "changed", {
    actor: "staff", staffId, now, series,
    previous: { appoint_date: current.appoint_date, time_mode: current.time_mode, time_start: current.time_start, time_end: current.time_end },
  }) : null;
  return { appointment: (await loadAppointment(id)) ?? updated, delivery, moved, shifted };
}

/**
 * เลื่อนนัดถัดไปในชุดตามนัดที่แก้ (นับจากนัดก่อนหน้า หรือจากนัดแรกเมื่อแก้นัดแรก)
 * ช่วงเวลาเดิมไม่มีในวันใหม่ → ใช้ช่วงแรกของวันนั้น นัดที่ปิดแล้วไม่แตะ
 */
async function shiftSeriesFollowers(seriesId: string, editedSeq: number, newDate: string, staffId: string): Promise<number> {
  const db = supabaseAdmin();
  const items = await loadSeries(seriesId);
  const moves = shiftFollowing(items.filter((a) => a.series_seq != null).map((a) => ({
    seq: a.series_seq as number, date: a.appoint_date, from: a.series_from ?? null, value: a.series_offset_value ?? null, unit: a.series_offset_unit ?? null,
  })), editedSeq, newDate);
  let count = 0;
  for (const m of moves) {
    const a = items.find((x) => x.series_seq === m.seq);
    if (!a || !OPEN_STATUSES.includes(a.status)) continue;
    let time: Record<string, unknown> = {};
    if (a.time_mode === "slot") {
      const schedule = await loadClinicSchedule(m.date, m.date);
      const slots = schedule.hours[weekdayOf(m.date)] ?? [];
      const slot = slots.find((s) => s.slot_id === a.slot_id) ?? slots[0];
      if (slot) time = { slot_id: slot.slot_id, time_start: slot.start, time_end: slot.end };
    }
    await db.from("appointments").update({
      appoint_date: m.date, ...time, status: "scheduled", reminder_sent_at: null, reminder_attempted_at: null, called_at: null, called_by: null, updated_at: nowIso(),
    }).eq("id", a.id);
    await logAppointmentEvent(a.id, "rescheduled", "staff", { staffId, detail: { from: a.appoint_date, to: m.date, by: "series" } });
    count++;
  }
  return count;
}

/** คนไข้ขอเลื่อนแล้วเจ้าหน้าที่นัดวันใหม่ให้: งาน "เลื่อนนัด" ในแชทเสร็จ แชทปิดได้ตามปกติ */
async function closeRescheduleTasks(conversationId: string, staffId: string) {
  const db = supabaseAdmin();
  const { data } = await db.from("chat_tasks").select("id, text").eq("conversation_id", conversationId).eq("done", false);
  const ids = ((data ?? []) as { id: string; text: string }[]).filter((t) => t.text.startsWith("เลื่อนนัด")).map((t) => t.id);
  if (ids.length) await db.from("chat_tasks").update({ done: true, done_by: staffId, done_at: nowIso() }).in("id", ids);
}

const CANCEL_CODES: CancelReason[] = ["patient", "doctor", "mistake", "other"];

/**
 * ยกเลิกต้องมีเหตุผล ไม่ลบแถว นัดที่ยกเลิกไม่เตือน ไม่เข้าคิวโทร ไม่นับในจำนวนนัด
 * ส่งข้อความแจ้งยกเลิกถ้ามีแชท ยกเว้น "ลงนัดผิด"
 */
export async function cancelAppointment(id: string, staffId: string, reason: { code?: unknown; text?: unknown; scope?: unknown } = {}): Promise<{ delivery: DeliveryResult | null; cancelled: number }> {
  const code = CANCEL_CODES.find((c) => c === reason.code);
  if (!code) throw new AppointmentError("เลือกเหตุผลการยกเลิก");
  const text = clip(reason.text, 300);
  if (code === "other" && !text) throw new AppointmentError("พิมพ์เหตุผลการยกเลิก");
  const loaded = await loadAppointment(id);
  const current = loaded ? { ...loaded } : null;
  if (!current) throw new AppointmentError("ไม่พบนัด", 404);
  if (!OPEN_STATUSES.includes(current.status)) throw new AppointmentError("นัดนี้มาแล้ว ไม่มา หรือยกเลิกแล้ว", 409);
  const at = nowIso();
  const label = code === "other" ? text : CANCEL_REASON_LABEL[code];
  const { data } = await supabaseAdmin().from("appointments").update({
    status: "cancelled", cancel_reason_code: code, cancel_reason: label, cancelled_by: staffId, cancelled_at: at, updated_at: at,
  }).eq("id", id).eq("status", current.status).select("id");
  if (!data?.length) throw new AppointmentError("นัดเพิ่งถูกแก้ไข ลองใหม่อีกครั้ง", 409);
  await logAppointmentEvent(id, "cancelled", "staff", { staffId, detail: { reason: label, code, previous_status: current.status } });
  const cancelledItems: Appointment[] = [current];
  // ยกเลิกทั้งชุด: นัดที่ยังเปิดอยู่ทั้งหมดในชุด
  if (reason.scope === "series" && current.series_id) {
    for (const a of await loadSeries(current.series_id)) {
      if (a.id === id || !OPEN_STATUSES.includes(a.status)) continue;
      const prev = a.status;
      const { data: ok } = await supabaseAdmin().from("appointments").update({
        status: "cancelled", cancel_reason_code: code, cancel_reason: label, cancelled_by: staffId, cancelled_at: at, updated_at: at,
      }).eq("id", a.id).eq("status", prev).select("id");
      if (!ok?.length) continue;
      cancelledItems.push({ ...a });
      await logAppointmentEvent(a.id, "cancelled", "staff", { staffId, detail: { reason: label, code, previous_status: prev, scope: "series" } });
    }
  }
  if (!notifiesOnCancel(code)) {
    await logAppointmentEvent(id, "send_skipped", "staff", { staffId, detail: { kind: "cancelled", reason: "ลงนัดผิด ไม่แจ้งคนไข้" } });
    return { delivery: null, cancelled: cancelledItems.length };
  }
  const series = current.series_id ? seriesView(cancelledItems.map((a) => ({ ...a, status: "scheduled" as const }))) : undefined;
  return { delivery: await deliverAppointment({ ...current, status: "cancelled" }, "cancelled", { actor: "staff", staffId, series }), cancelled: cancelledItems.length };
}

/** กู้คืนนัดที่ยกเลิกภายในวันเดียวกัน กลับเป็นสถานะก่อนยกเลิก (ไม่ส่งข้อความอัตโนมัติ) */
export async function restoreAppointment(id: string, staffId: string, now = Date.now()): Promise<{ appointment: Appointment }> {
  const current = await loadAppointment(id);
  if (!current) throw new AppointmentError("ไม่พบนัด", 404);
  if (!canRestore(current, now)) throw new AppointmentError("กู้คืนได้เฉพาะนัดที่ยกเลิกวันนี้", 409);
  if (current.appoint_date < bangkokToday(now)) throw new AppointmentError("วันนัดผ่านไปแล้ว", 409);
  const { data: ev } = await supabaseAdmin().from("appointment_events").select("detail, created_at")
    .eq("appointment_id", id).eq("kind", "cancelled").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const prev = (ev?.detail as { previous_status?: string } | null)?.previous_status;
  const status = prev === "confirmed" || prev === "reschedule_requested" ? prev : "scheduled";
  await supabaseAdmin().from("appointments").update({
    status, cancel_reason: null, cancel_reason_code: null, cancelled_by: null, cancelled_at: null, updated_at: nowIso(),
  }).eq("id", id).eq("status", "cancelled");
  await logAppointmentEvent(id, "restored", "staff", { staffId, detail: { status } });
  return { appointment: (await loadAppointment(id)) as Appointment };
}

export async function setCalled(id: string, called: boolean, staffId: string) {
  const { data } = await supabaseAdmin().from("appointments")
    .update({ called_at: called ? nowIso() : null, called_by: called ? staffId : null, updated_at: nowIso() }).eq("id", id).select("id");
  if (!data?.length) throw new AppointmentError("ไม่พบนัด", 404);
  await logAppointmentEvent(id, called ? "called" : "call_unmarked", "staff", { staffId });
}

// ---------------------------------------------------------------------------
// webhook: ปุ่มยืนยัน/ขอเลื่อน และรหัสจากใบนัด
// ---------------------------------------------------------------------------
export interface InboundRef {
  channelType: ChannelType;
  externalId: string;
  /** id ของ event ใช้กันซ้ำ */
  eventId: string;
  replyToken?: string;
  displayName?: string;
  avatarUrl?: string;
}

const isPast = (a: Appointment, now: number) => a.appoint_date < bangkokToday(now);

/**
 * ยืนยัน → confirmed ตอบขอบคุณ แชทคงสถานะเดิม
 * ขอเลื่อน → reschedule_requested ย้ายแชทเข้ารอตอบด้วยงาน "เลื่อนนัด" (ปิดแชทไม่ได้จนกว่างานเสร็จ)
 * AI ไม่ตอบ เพราะไม่ผ่าน processIncoming
 */
export async function handleAppointmentPostback(ref: InboundRef, payload: string, label: string, now = Date.now()): Promise<"confirmed" | "reschedule" | "ignored" | "duplicate"> {
  const parsed = parseAppointmentPostback(payload);
  if (!parsed) return "ignored";
  if (await alreadyHandled(ref.eventId)) return "duplicate";
  const db = supabaseAdmin();
  const conversationId = await ensureConversation(ref.channelType, ref.externalId, ref.displayName, ref.avatarUrl);
  const info = await conversationInfo(conversationId);
  if (!info) return "ignored";
  const lang: Lang = pickLanguage(info.language);
  await insertSystemMessage(conversationId, { direction: "in", body: `[กดปุ่ม] ${label || (parsed.action === "confirm" ? "ยืนยันนัด" : "ขอเลื่อนนัด")}`, language: lang, externalId: ref.eventId });

  if (parsed.appointmentId === TEST_APPOINTMENT_ID) {
    await replyText(info, REPLY_TEXT[lang].test, ref.replyToken);
    return "ignored";
  }
  const appt = await loadAppointment(parsed.appointmentId);
  // กดได้จากทุกบัญชีที่รับข้อความของนัดนี้ (คนไข้/ญาติ) บัญชีอื่นคือข้อมูลปลอมหรือถูกยกเลิกการผูกแล้ว
  if (!appt || !(await recipientIds(appt)).includes(conversationId)) return "ignored";
  const relation = (await rolesForHn(appt.hn, [conversationId])).get(conversationId) ?? (await relationsOf([conversationId])).get(conversationId) ?? (appt.conversation_id === conversationId ? "patient" : "relative");
  const who = { conversation_id: conversationId, account: info.displayName, relation };
  if (!OPEN_STATUSES.includes(appt.status) || isPast(appt, now)) {
    await replyText(info, REPLY_TEXT[lang].closed, ref.replyToken);
    return "ignored";
  }

  if (parsed.action === "confirm") {
    await db.from("appointments").update({ status: "confirmed", updated_at: nowIso() }).eq("id", appt.id);
    await logAppointmentEvent(appt.id, "confirmed", "customer", { channel: info.channelType, detail: who });
    await replyText(info, REPLY_TEXT[lang].confirmed, ref.replyToken);
    return "confirmed";
  }

  await db.from("appointments").update({ status: "reschedule_requested", called_at: null, called_by: null, updated_at: nowIso() }).eq("id", appt.id);
  await logAppointmentEvent(appt.id, "reschedule_requested", "customer", { channel: info.channelType, detail: who });
  await replyText(info, REPLY_TEXT[lang].reschedule, ref.replyToken);
  await db.from("chat_tasks").insert({
    conversation_id: conversationId,
    text: `เลื่อนนัด: คนไข้ขอเลื่อนนัด ${thaiShortDate(appt.appoint_date)} ${timeShort(appt)} น. — โทรนัดวันใหม่`,
  });
  // เข้ารอตอบ: แชทต้องเปิดอยู่ งานค้างทำให้ค้างในรอตอบเอง
  if (info.status !== "open") await db.from("conversations").update({ status: "open" }).eq("id", conversationId);
  await sendPushToStaff(null, { title: "📅 คนไข้ขอเลื่อนนัด", body: "มีคนไข้ขอเลื่อนนัด 1 รายการ", url: "/appointments" })
    .catch((e) => console.error("reschedule push failed", e));
  return "reschedule";
}

/**
 * "ยืนยันนัด #XXXXXX": ผูกนัดกับแชท ผูกแชทกับ HN แล้วส่งข้อความนัดพร้อมปุ่มให้บัญชีที่สแกนทันที
 * นัดมีแชทหลักอยู่แล้ว (ญาติหรือเบอร์ใหม่สแกน) = เพิ่มบัญชีที่รับแจ้งเตือน ไม่แทนบัญชีเดิม
 */
export async function handleLinkCode(ref: InboundRef, text: string, code: string, now = Date.now()): Promise<"linked" | "not_found" | "closed" | "duplicate"> {
  if (await alreadyHandled(ref.eventId)) return "duplicate";
  const db = supabaseAdmin();
  const conversationId = await ensureConversation(ref.channelType, ref.externalId, ref.displayName, ref.avatarUrl);
  const info = await conversationInfo(conversationId);
  if (!info) return "not_found";
  const lang = pickLanguage(info.language);
  await insertSystemMessage(conversationId, { direction: "in", body: text, language: lang, externalId: ref.eventId });

  const { data } = await db.from("appointments").select(APPOINTMENT_COLUMNS).eq("link_code", code).maybeSingle();
  const appt = data as unknown as Appointment | null;
  if (!appt) {
    await replyText(info, REPLY_TEXT[lang].notFound, ref.replyToken);
    return "not_found";
  }
  if (!OPEN_STATUSES.includes(appt.status) || isPast(appt, now)) {
    await replyText(info, REPLY_TEXT[lang].closed, ref.replyToken);
    return "closed";
  }
  const alreadyLinked = appt.hn
    ? (await linksOfConversation(conversationId)).some((l) => sameHn(l.hn, appt.hn))
    : appt.conversation_id === conversationId
      || !!(await db.from("appointment_recipients").select("conversation_id").eq("appointment_id", appt.id).eq("conversation_id", conversationId).maybeSingle()).data;
  if (alreadyLinked) {
    if (!appt.conversation_id) await db.from("appointments").update({ conversation_id: conversationId, last_send_error: null, updated_at: nowIso() }).eq("id", appt.id);
    await logAppointmentEvent(appt.id, "linked", "customer", { channel: info.channelType, detail: { code, conversation_id: conversationId, already: true } });
    await replyText(info, REPLY_TEXT[lang].alreadyLinked, ref.replyToken);
    return "linked";
  }
  const added = !!appt.conversation_id && appt.conversation_id !== conversationId;
  if (!appt.conversation_id) {
    await db.from("appointments").update({ conversation_id: conversationId, last_send_error: null, updated_at: nowIso() }).eq("id", appt.id);
  } else if (added && !appt.hn) {
    // ไม่มี HN: จำบัญชีเพิ่มไว้ที่นัด (และทุกนัดในชุด) มี HN ใช้ patient_links ด้านล่าง
    const ids = appt.series_id ? (await loadSeries(appt.series_id)).map((x) => x.id) : [appt.id];
    await db.from("appointment_recipients").upsert(ids.map((id) => ({ appointment_id: id, conversation_id: conversationId })), { onConflict: "appointment_id,conversation_id", ignoreDuplicates: true });
  }
  await logAppointmentEvent(appt.id, "linked", "customer", { channel: info.channelType, detail: { code, conversation_id: conversationId, account: info.displayName, ...(added ? { added: true } : {}) } });
  if (appt.hn) {
    // นัดอื่นของคนไข้คนเดียวกันที่ยังไม่มีแชท ได้ข้อความเตือนด้วย
    const { data: others } = await db.from("appointments").select("id, status, conversation_id").eq("hn", appt.hn).is("conversation_id", null);
    const ids = ((others ?? []) as { id: string; status: string }[]).filter((o) => OPEN_STATUSES.includes(o.status as Appointment["status"])).map((o) => o.id);
    if (ids.length) await db.from("appointments").update({ conversation_id: conversationId, updated_at: nowIso() }).in("id", ids);
  }
  if (appt.series_id) {
    await db.from("appointments").update({ conversation_id: conversationId, updated_at: nowIso() }).eq("series_id", appt.series_id).is("conversation_id", null);
  }
  await deliverAppointment({ ...appt, conversation_id: appt.conversation_id ?? conversationId }, "linked", {
    actor: "customer", replyToken: ref.replyToken, now, only: conversationId, series: appt.series_id ? seriesView(await loadSeries(appt.series_id)) : undefined,
  });
  // ผูกชื่อหลังตอบ replyToken หมดอายุเร็ว ส่วนการค้น iService ใช้เวลาได้
  if (appt.hn) {
    await linkConversationToHn(conversationId, appt.hn, {
      via: "link_code", staffId: null, fallbackName: appt.patient_name, fallbackFromHis: !!appt.name_from_his, phone: appt.phone,
    }).catch((e) => console.error("link hn failed", e));
  }
  return "linked";
}

// ---------------------------------------------------------------------------
// เตือนก่อนวันนัด 1 วัน (cron ทุก 15 นาที)
// ---------------------------------------------------------------------------
export async function runAppointmentReminders(now = Date.now()): Promise<{ sent: number; failed: number; skipped: number }> {
  const db = supabaseAdmin();
  const settings = await loadAppointmentSettings();
  const tomorrow = addDays(bangkokToday(now), 1);
  const { data } = await db.from("appointments").select(APPOINTMENT_COLUMNS)
    .eq("appoint_date", tomorrow).in("status", ["scheduled", "confirmed"]).is("reminder_sent_at", null).is("reminder_attempted_at", null);
  const result = { sent: 0, failed: 0, skipped: 0 };
  for (const appt of (data ?? []) as unknown as Appointment[]) {
    const decision = reminderDecision(appt, settings, now);
    if (!decision) continue;
    // จองรายการก่อนส่ง cron ที่รันซ้อนกันจะไม่ส่งซ้ำ
    const { data: claimed } = await db.from("appointments").update({ reminder_attempted_at: new Date(now).toISOString() })
      .eq("id", appt.id).is("reminder_attempted_at", null).select("id");
    if (!claimed?.length) continue;
    if (decision === "skip") {
      result.skipped++;
      await logAppointmentEvent(appt.id, "reminder_skipped", "system", { detail: { reason: "ส่งข้อความนัดไปแล้ววันนี้" } });
      continue;
    }
    const r = await deliverAppointment(appt, "reminder", { actor: "system", now, seriesPosition: await seriesPosition(appt) });
    if (r.sent) result.sent++;
    else result.failed++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// ส่งทดสอบจากหน้าตั้งค่า
// ---------------------------------------------------------------------------
export async function sendTestAppointment(conversationId: string, staffId: string, now = Date.now()): Promise<DeliveryResult> {
  const info = await conversationInfo(conversationId);
  const delivery = chooseDelivery({ channelType: info?.channelType ?? null, lastInboundAt: info?.lastInboundAt ?? null, archived: info?.archived, unfollowed: info?.unfollowed, now });
  if (!info || !delivery.ok) return { sent: false, via: info?.channelType, error: DELIVERY_FAILURE_TEXT[delivery.ok ? "no_chat" : delivery.reason] };
  const [settings, clinic] = await Promise.all([loadAppointmentSettings(), clinicName()]);
  const input = messageInput({
    id: TEST_APPOINTMENT_ID, patient_name: info.displayName || "ทดสอบ", appoint_date: addDays(bangkokToday(now), 1),
    time_mode: "slot", time_start: "08:00", time_end: "12:00", purpose_text: "ทดสอบเหตุผลนัด", instructions: "ตัวอย่างการปฏิบัติตัว",
  }, "test", info, settings, clinic);
  try {
    const mid = await pushAppointment(info, delivery.via, input);
    await insertSystemMessage(info.id, { direction: "out", body: appointmentText(input), language: input.lang, externalId: mid, label: `${APPOINTMENT_SENDER_NAME} (ทดสอบ)` });
  } catch (e) {
    return { sent: false, via: delivery.via, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
  console.info("appointment test sent by", staffId);
  return { sent: true, via: delivery.via };
}

// ---------------------------------------------------------------------------
// หน้านัดหมาย
// ---------------------------------------------------------------------------
export interface AppointmentListRow extends Appointment {
  channel: ChannelType | null;
  chat_name: string | null;
  series_total: number | null;
}

/** ค้นหาใช้ใน PostgREST or() จึงตัดตัวอักษรที่มีความหมายในไวยากรณ์ออก */
const searchTerm = (q: string) => q.replace(/[,()%*\:"']/g, " ").trim().slice(0, 60);

export type ListTab = "today" | "tomorrow" | "all";
/** ตัวกรองหน้านัดหมาย: purpose ใช้ทุกแท็บ q/from/to/status ใช้เฉพาะแท็บทั้งหมด (from/to ว่าง = ไม่กรองวัน) */
export interface ListFilters { q?: string; from?: string | null; to?: string | null; purpose?: string | null; status?: string | null; /** แท็บทั้งหมด: รวมนัดที่ยกเลิก */ includeCancelled?: boolean }
export const LIST_LIMIT = 500;
const LIST_STATUSES = ["scheduled", "confirmed", "reschedule_requested", "cancelled", "attended", "no_show"];

/**
 * เงื่อนไขชุดเดียวใช้ทั้งรายการและตัวเลข badge ของแท็บ ตัวเลขจึงตรงกับที่แสดงเสมอ
 * แสดงทุกสถานะ (รวมมาแล้ว/ไม่มา) ไม่รวมเข็มที่ฉีดแล้ว (บันทึกประวัติ ไม่ใช่นัด)
 * นัดที่ยกเลิก: ซ่อนจากแท็บพรุ่งนี้/วันนี้เสมอ · แท็บทั้งหมดแสดงเมื่อเลือก "รวมยกเลิก" หรือกรองสถานะยกเลิก (ลบถาวรเมื่อพ้นระยะเก็บ)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyListFilters<Q extends { eq: any; gte: any; lte: any; or: any; neq: any; is: any }>(query: Q, tab: ListTab, opts: ListFilters, today: string): Q {
  let qy = query;
  if (tab === "today") qy = qy.eq("appoint_date", today).neq("status", "cancelled");
  else if (tab === "tomorrow") qy = qy.eq("appoint_date", addDays(today, 1)).neq("status", "cancelled");
  else {
    if (!opts.includeCancelled && opts.status !== "cancelled") qy = qy.neq("status", "cancelled");
    if (opts.from) qy = qy.gte("appoint_date", opts.from);
    if (opts.to) qy = qy.lte("appoint_date", opts.to);
    const q = searchTerm(opts.q ?? "");
    if (q) qy = qy.or(`patient_name.ilike.%${q}%,hn.ilike.%${q}%,phone.ilike.%${q}%`);
    if (opts.status && LIST_STATUSES.includes(opts.status)) qy = qy.eq("status", opts.status);
  }
  qy = qy.neq("series_done", true);
  if (opts.purpose === "none") qy = qy.is("purpose_id", null);
  else if (opts.purpose && UUID.test(opts.purpose)) qy = qy.eq("purpose_id", opts.purpose);
  return qy;
}

/** จำนวนนัดของทุกแท็บตามตัวกรองปัจจุบัน (ตัวกรองเดียวกับรายการ) */
export async function appointmentTabCounts(opts: ListFilters = {}, now = Date.now()): Promise<Record<ListTab, number>> {
  const today = bangkokToday(now);
  const count = async (tab: ListTab) => {
    const { count: n } = await applyListFilters(supabaseAdmin().from("appointments").select("id", { count: "exact", head: true }), tab, opts, today);
    return n ?? 0;
  };
  const [t, tm, all] = await Promise.all([count("today"), count("tomorrow"), count("all")]);
  return { today: t, tomorrow: tm, all };
}

/** purpose: id ของ preset หรือ "none" = ไม่ได้เลือก preset ทุกแท็บเรียงนัดที่ใกล้ถึงก่อน (แท็บทั้งหมด: อนาคตใกล้→ไกล แล้วอดีตล่าสุด→เก่า) */
export async function listAppointments(opts: { tab: ListTab } & ListFilters, now = Date.now()): Promise<AppointmentListRow[]> {
  const today = bangkokToday(now);
  const base = supabaseAdmin().from("appointments")
    // ระบุ FK: appointment_recipients ทำให้ appointments↔conversations มีได้หลายเส้นทาง PostgREST จะตอบ error (PGRST201) ถ้าไม่ระบุ
    .select(`${APPOINTMENT_COLUMNS}, conversations!appointments_conversation_id_fkey(channels(type), contacts(display_name, platform_name, hn, patient_full_name, patient_relation, name_locked))`);
  // ใกล้ถึงก่อนเสมอ: นัดตั้งแต่วันนี้เรียงใกล้→ไกล แล้วต่อด้วยนัดที่ผ่านแล้ว ล่าสุด→เก่า
  let data: unknown[] | null;
  if (opts.tab === "all") {
    const sel = () => supabaseAdmin().from("appointments")
      .select(`${APPOINTMENT_COLUMNS}, conversations!appointments_conversation_id_fkey(channels(type), contacts(display_name, platform_name, hn, patient_full_name, patient_relation, name_locked))`);
    const [{ data: up }, { data: past }] = await Promise.all([
      applyListFilters(sel(), "all", opts, today).gte("appoint_date", today)
        .order("appoint_date", { ascending: true }).order("time_start", { ascending: true }).limit(LIST_LIMIT),
      applyListFilters(sel(), "all", opts, today).lt("appoint_date", today)
        .order("appoint_date", { ascending: false }).order("time_start", { ascending: false }).limit(LIST_LIMIT),
    ]);
    data = [...(up ?? []), ...(past ?? [])].slice(0, LIST_LIMIT);
  } else {
    ({ data } = await applyListFilters(base, opts.tab, opts, today)
      .order("appoint_date", { ascending: true }).order("time_start", { ascending: true }).limit(LIST_LIMIT));
  }
  // วันนี้: คนไข้ที่มาแล้วย้ายไปท้าย (ยังรอ = ที่ต้องดู)
  if (opts.tab === "today" && data) {
    const arrived = (r: unknown) => ((r as { status: string }).status === "attended" ? 1 : 0);
    data = [...data].sort((a, b) => arrived(a) - arrived(b));
  }
  const seriesIds = [...new Set(((data ?? []) as { series_id?: string | null }[]).map((r) => r.series_id).filter((x): x is string => !!x))];
  const seriesTotal = new Map<string, number>();
  if (seriesIds.length) {
    const { data: sib } = await supabaseAdmin().from("appointments").select("series_id, status, series_seq").in("series_id", seriesIds);
    for (const r of (sib ?? []) as { series_id: string; status: string; series_seq: number | null }[]) {
      if (r.status !== "cancelled") seriesTotal.set(r.series_id, Math.max(seriesTotal.get(r.series_id) ?? 0, r.series_seq ?? 0));
    }
  }
  return ((data ?? []) as unknown as (Appointment & { conversations: unknown })[]).map(({ conversations, ...a }) => {
    const conv = (Array.isArray(conversations) ? conversations[0] : conversations) as { channels?: { type: ChannelType } | { type: ChannelType }[]; contacts?: ContactNameFields | ContactNameFields[] } | null;
    const channel = conv?.channels ? (Array.isArray(conv.channels) ? conv.channels[0] : conv.channels) : null;
    const contact = conv?.contacts ? (Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts) : null;
    return { ...a, channel: channel?.type ?? null, chat_name: contact ? contactName(contact) : null, series_total: a.series_id ? seriesTotal.get(a.series_id) ?? null : null };
  });
}

/** badge ที่เมนู: ต้องโทร + ขอเลื่อน */
export async function appointmentCallCounts(now = Date.now()) {
  const { data } = await supabaseAdmin().from("appointments")
    .select("status, conversation_id, last_send_error, confirm_sent_at, reminder_sent_at, appoint_date, called_at")
    .gte("appoint_date", bangkokToday(now)).in("status", ["scheduled", "reschedule_requested"]).is("called_at", null);
  return callQueue((data ?? []) as Parameters<typeof callQueue>[0], now);
}

/** ข้อมูลช่วยกรอกฟอร์ม: เหตุผลนัดที่เคยพิมพ์ ผู้นัด เวลาที่ใช้บ่อย และแชทที่ผูกกับ HN */
export async function appointmentFormData(hn: string | null, now = Date.now(), currentProvider?: string | null) {
  const db = supabaseAdmin();
  const today = bangkokToday(now);
  const [{ data: recent }, linked, schedule, presets, { data: templates }, { data: providerRows }, { data: todayVisits }, patient] = await Promise.all([
    db.from("appointments").select("purpose_id, purpose_text, created_at").order("created_at", { ascending: false }).limit(500),
    findLinkedConversation(hn),
    loadClinicSchedule(today, addDays(today, 400)),
    loadPurposes(),
    db.from("appointment_series_templates").select("id, name, purpose_id, items, sort_order, active").eq("active", true),
    db.from("providers").select("name, last_seen_at, active"),
    // แพทย์ที่ตรวจคนไข้รายนี้ใน visit วันนี้ (ป้าย "ตรวจวันนี้" ไม่เลือกให้)
    hn ? db.from("his_visit_cache").select("doctor_name").eq("visit_date", today).in("hn", hnVariants(hn)) : Promise.resolve({ data: [] }),
    // ชื่อ + เบอร์ของ HN นี้ (iService list_patient ฝั่ง server · สำรองจากตาราง patients)
    hn ? patientContact(hn) : Promise.resolve(null),
  ]);
  const rows = (recent ?? []) as { purpose_id: string | null; purpose_text: string | null }[];
  const todayDoctors = ((todayVisits ?? []) as { doctor_name: string | null }[]).map((v) => cleanProviderName(v.doctor_name)).filter(Boolean);
  let linkedChannel: ChannelType | null = null;
  if (linked) {
    const info = await conversationInfo(linked);
    linkedChannel = info?.channelType ?? null;
  }
  return {
    presets: presets.filter((p) => p.active),
    // เหตุผลที่พิมพ์เอง (ไม่ใช่ preset) ใช้เป็น autocomplete ของ "อื่นๆ"
    purposeHistory: frequentTexts(rows.filter((r) => !r.purpose_id || !presets.some((p) => p.id === r.purpose_id && p.name === r.purpose_text)).map((r) => r.purpose_text)),
    providers: providerOptions((providerRows ?? []) as Provider[], todayDoctors, currentProvider, now),
    linked: linked ? { conversation_id: linked, channel: linkedChannel } : null,
    patient,
    schedule,
    templates: ((templates ?? []) as { id: string; name: string; purpose_id: string | null; items: unknown; sort_order: number }[])
      .sort((a, b) => a.sort_order - b.sort_order).map(({ sort_order: _s, ...t }) => t),
  };
}

/**
 * ข้อมูลใบนัด: พิมพ์ QR + รหัสทุกใบ (ผูกแล้วก็พิมพ์ ให้ญาติหรือเบอร์ใหม่สแกนเพิ่มได้)
 * issuer = เจ้าหน้าที่ที่เปิดหน้าพิมพ์
 */
export async function appointmentSlip(id: string, issuerId?: string | null) {
  const appt = await loadAppointment(id);
  if (!appt) return null;
  const db = supabaseAdmin();
  const [settings, clinic, accounts] = await Promise.all([loadAppointmentSettings(), clinicName(), linkedAccounts(appt)]);
  const series = appt.series_id ? (await loadSeries(appt.series_id)).filter((a) => a.status !== "cancelled") : [];
  const [{ data: seriesRow }, { data: issuer }] = await Promise.all([
    appt.series_id ? db.from("appointment_series").select("title").eq("id", appt.series_id).maybeSingle() : Promise.resolve({ data: null }),
    issuerId ? db.from("staff").select("display_name").eq("id", issuerId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const s = seriesRow as { title: string | null } | null;
  const data: SlipData = {
    appointment: appt,
    series,
    // ชุดนัด: หัวใบใช้ชื่อชุดที่ตั้งเอง (ถ้าเป็นแค่ชื่อเหตุผลนัดใช้ "ใบนัดวัคซีน")
    seriesTitle: s?.title && s.title !== appt.purpose_text ? s.title : null,
    clinic: { name: clinic, nameEn: settings.clinic_name_en, address: settings.clinic_address, addressEn: settings.clinic_address_en, phone: settings.clinic_phone, mobile: settings.clinic_mobile },
    linkedLine: accounts.some((a) => a.channel === "line" && a.following),
    issuedBy: ((issuer as { display_name?: string } | null)?.display_name ?? "").trim() || "เจ้าหน้าที่",
    issuedAt: nowIso(),
  };
  return {
    ...data,
    accounts,
    qrUrl: lineOaMessageUrl(settings.line_oa_id, appt.link_code),
  };
}

/** ต้นฉบับข้อความที่แปลได้ของใบนัดนี้ (ไม่มีชื่อ HN เบอร์) */
async function slipSources(id: string) {
  const slip = await appointmentSlip(id);
  return slip ? slipSourceTexts(slip) : null;
}

/** กด EN บนหน้าพิมพ์: แปลเหตุผล การปฏิบัติตัว หมายเหตุ ชื่อชุดนัด (ใช้ cache ก่อน) */
export async function translateSlip(id: string) {
  const src = await slipSources(id);
  if (!src) return null;
  return translateSlipTexts(src);
}

/** HN ของนัด (ใช้แก้ป้ายบัญชีต่อ HN จาก drawer) */
export async function appointmentHn(id: string): Promise<string | null> {
  return (await loadAppointment(id))?.hn ?? null;
}

/** พนักงานแก้คำแปลใน preview: เก็บเป็นค่าใน cache ของต้นฉบับข้อความนั้น */
export async function editSlipTranslation(id: string, field: SlipField, text: string): Promise<boolean> {
  const src = await slipSources(id);
  const source = src?.[field];
  if (!source) return false;
  await saveSlipTranslation(source, text);
  return true;
}

/**
 * แอดมินยกเลิกการรับข้อความของบัญชีหนึ่งจาก drawer นัด
 * ผูกผ่าน HN = ยกเลิกการผูก HN ของแชทนั้น (ทุกนัดของ HN) ผ่านรหัส = เอาออกจากนัดนี้และชุดเดียวกัน
 * ถ้าเป็นแชทหลักของนัด ย้ายแชทหลักไปบัญชีที่เหลือ
 */
export async function detachAccount(id: string, conversationId: string, staffId: string): Promise<boolean> {
  const db = supabaseAdmin();
  const appt = await loadAppointment(id);
  if (!appt) return false;
  const viaHn = (await linkedConversationsOf(appt.hn)).some((l) => l.conversation_id === conversationId);
  // ยกเลิกเฉพาะแถว (บัญชี + HN ของนัดนี้) HN อื่นของบัญชีเดียวกันไม่กระทบ
  if (viaHn) await unlinkConversation(conversationId, staffId, appt.hn);
  const ids = appt.series_id ? (await loadSeries(appt.series_id)).map((x) => x.id) : [appt.id];
  await db.from("appointment_recipients").delete().eq("conversation_id", conversationId).in("appointment_id", ids);
  const fresh = await loadAppointment(id);
  if (fresh?.conversation_id === conversationId) {
    const next = (await recipientIds({ ...fresh, conversation_id: null })).find((x) => x !== conversationId) ?? null;
    await db.from("appointments").update({ conversation_id: next, updated_at: nowIso() }).in("id", ids).eq("conversation_id", conversationId);
    if (next) await db.from("appointment_recipients").delete().eq("conversation_id", next).in("appointment_id", ids);
  }
  await logAppointmentEvent(appt.id, "unlinked", "staff", { staffId, detail: { conversation_id: conversationId } });
  return true;
}

export async function appointmentEvents(id: string) {
  const db = supabaseAdmin();
  const { data } = await db.from("appointment_events").select("id, kind, actor, staff_id, channel, detail, created_at")
    .eq("appointment_id", id).order("created_at");
  const rows = (data ?? []) as { staff_id: string | null }[];
  const ids = [...new Set(rows.map((r) => r.staff_id).filter((x): x is string => !!x))];
  const { data: staff } = ids.length ? await db.from("staff").select("id, display_name").in("id", ids) : { data: [] };
  const name = new Map(((staff ?? []) as { id: string; display_name: string }[]).map((s) => [s.id, s.display_name]));
  return rows.map((r) => ({ ...r, staff_name: r.staff_id ? name.get(r.staff_id) ?? null : null }));
}

export async function loadPurposes(): Promise<PurposeRow[]> {
  const { data } = await supabaseAdmin().from("appointment_purposes").select("id, name, default_days, reminder_extra_text, sort_order, active");
  return ((data ?? []) as PurposeRow[]).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

/** จำนวนนัดต่อวันและต่อช่วง (นับ scheduled/confirmed/reschedule_requested) key ของช่วงเวลาตรงคือ "exact" */
export async function appointmentDayCounts(from: string, to: string): Promise<Record<string, { total: number; slots: Record<string, number> }>> {
  const { data } = await supabaseAdmin().from("appointments").select("appoint_date, time_mode, slot_id, status")
    .gte("appoint_date", from).lte("appoint_date", to).in("status", ["scheduled", "confirmed", "reschedule_requested"]);
  const out: Record<string, { total: number; slots: Record<string, number> }> = {};
  for (const r of (data ?? []) as { appoint_date: string; time_mode: string; slot_id: string | null }[]) {
    const day = (out[r.appoint_date] ??= { total: 0, slots: {} });
    const key = r.time_mode === "slot" && r.slot_id ? r.slot_id : "exact";
    day.total++;
    day.slots[key] = (day.slots[key] ?? 0) + 1;
  }
  return out;
}

/** ตัวเลขบนแท็บหน้านัดหมาย (ไม่นับนัดที่ยกเลิก) all = ตั้งแต่วันนี้เป็นต้นไป */

/** HN ที่มีนัดในอนาคตอยู่แล้ว ใช้แสดงป้าย "มีนัดแล้ว" ในรายการคนไข้วันนี้ */
export async function upcomingAppointmentHns(now = Date.now()): Promise<string[]> {
  const { data } = await supabaseAdmin().from("appointments").select("hn")
    .gt("appoint_date", bangkokToday(now)).in("status", OPEN_STATUSES).not("hn", "is", null);
  return [...new Set(((data ?? []) as { hn: string | null }[]).map((r) => r.hn?.trim()).filter((h): h is string => !!h))];
}

// ---------------------------------------------------------------------------
// คนไข้ใหม่ที่นัดจากแชท: จับคู่ HN หลังมาตรวจครั้งแรก (mark-attendance เสนอ แอดมินยืนยัน)
// ---------------------------------------------------------------------------
export interface HnMatchRow {
  id: string; hn: string; his_name: string | null; matched_by: "name" | "name_phone"; created_at: string;
  appointment: { id: string; patient_name: string; phone: string | null; appoint_date: string; conversation_id: string | null } | null;
}

export async function listHnMatches(): Promise<HnMatchRow[]> {
  const { data } = await supabaseAdmin().from("appointment_hn_matches")
    .select("id, hn, his_name, matched_by, created_at, appointments(id, patient_name, phone, appoint_date, conversation_id)")
    .eq("status", "pending").order("created_at");
  return ((data ?? []) as unknown as (Omit<HnMatchRow, "appointment"> & { appointments: HnMatchRow["appointment"] | HnMatchRow["appointment"][] })[])
    .map(({ appointments, ...m }) => ({ ...m, appointment: Array.isArray(appointments) ? appointments[0] ?? null : appointments }));
}

/**
 * ยืนยัน: ผูก HN กับแชท (ชื่อจาก HIS) ใส่ HN/ชื่อจริงในนัด และนัดเป็น attended ข้อเสนออื่นของนัดเดียวกันถูกปัดตก
 * ปฏิเสธ: ถ้าไม่เหลือข้อเสนออื่น นัดเป็น no_show ตามปกติ
 */
export async function decideHnMatch(matchId: string, accept: boolean, staffId: string): Promise<{ status: string }> {
  const db = supabaseAdmin();
  const { data: match } = await db.from("appointment_hn_matches").select("id, appointment_id, hn, his_name, status").eq("id", matchId).maybeSingle();
  if (!match || match.status !== "pending") throw new AppointmentError("ข้อเสนอนี้ถูกตัดสินไปแล้ว", 409);
  const appt = await loadAppointment(match.appointment_id as string);
  if (!appt) throw new AppointmentError("ไม่พบนัด", 404);
  const at = nowIso();
  const hn = match.hn as string;

  if (!accept) {
    await db.from("appointment_hn_matches").update({ status: "rejected", decided_by: staffId, decided_at: at }).eq("id", matchId);
    const { data: left } = await db.from("appointment_hn_matches").select("id").eq("appointment_id", appt.id).eq("status", "pending");
    if (!left?.length && OPEN_STATUSES.includes(appt.status)) {
      await db.from("appointments").update({ status: "no_show", updated_at: at }).eq("id", appt.id);
      await logAppointmentEvent(appt.id, "no_show", "staff", { staffId, detail: { reason: "ปฏิเสธการจับคู่ HN" } });
      return { status: "no_show" };
    }
    return { status: appt.status };
  }

  let name = (match.his_name as string | null)?.trim() || appt.patient_name;
  if (appt.conversation_id) {
    const linked = await linkConversationToHn(appt.conversation_id, hn, { via: "staff", staffId, fallbackName: name, fallbackFromHis: true, phone: appt.phone });
    if (linked?.name) name = linked.name;
  }
  await db.from("appointments").update({
    hn, patient_name: name, name_from_his: true,
    ...(OPEN_STATUSES.includes(appt.status) ? { status: "attended" } : {}),
    updated_at: at,
  }).eq("id", appt.id);
  await db.from("appointment_hn_matches").update({ status: "accepted", decided_by: staffId, decided_at: at }).eq("id", matchId);
  await db.from("appointment_hn_matches").update({ status: "rejected", decided_by: staffId, decided_at: at }).eq("appointment_id", appt.id).eq("status", "pending");
  await logAppointmentEvent(appt.id, "hn_match_accepted", "staff", { staffId, detail: { hn } });
  return { status: "attended" };
}

/** LINE follow/unfollow: บันทึกที่รายชื่อ ใช้ตัดสินว่าส่งข้อความนัดได้ไหม */
export async function setLineFollow(userId: string, following: boolean) {
  const db = supabaseAdmin();
  const { data: channel } = await db.from("channels").select("id").eq("type", "line").eq("enabled", true).order("created_at").limit(1).maybeSingle();
  if (!channel) return;
  await db.from("contacts").update({ line_unfollowed_at: following ? null : nowIso() }).eq("channel_id", channel.id).eq("external_id", userId);
}
