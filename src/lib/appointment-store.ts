import {
  addDays, appointmentFlex, callQueue, frequentTexts, lineOaMessageUrl, appointmentText, bangkokToday, chooseDelivery, DELIVERY_FAILURE_TEXT, generateLinkCode,
  metaAppointmentMessage, normalizeAppointmentSettings, OPEN_STATUSES, parseDate, parseTime, parseAppointmentPostback, pickLanguage, REPLY_TEXT,
  reminderDecision, TEST_APPOINTMENT_ID, thaiShortDate, timeShort, weekdayOf,
  type Appointment, type AppointmentSettings, type ClinicSchedule, type ClinicSlot, type Lang, type MessageInput, type MessageKind,
} from "./appointment-rules";
import { sendPushToStaff } from "./booking-store";
import { lineSendMessages } from "./channels/line";
import { metaSendMessage } from "./channels/meta";
import { DEFAULT_CLINIC_PROFILE, getSetting } from "./mode";
import { SENSITIVE_TAG } from "./sensitive-rules";
import { linkConversationToHn } from "./patient-link-store";
import { contactName, type ContactNameFields } from "./patient-name";
import { supabaseAdmin } from "./supabase/admin";
import type { ChannelType } from "./types";

/**
 * ระบบนัดครั้งต่อไป: ข้อความทุกข้อความที่ระบบนี้ส่งหรือรับเป็น sender_type 'system'
 * จึงไม่นับในคิวรอตอบ ไม่ทำให้แชทที่เสร็จแล้วเด้งกลับ และไม่ถูกส่งเข้า AI (suggest.ts ข้าม system)
 */
export const APPOINTMENT_SENDER_NAME = "ระบบนัด";

export const APPOINTMENT_COLUMNS = "id, hn, patient_name, phone, conversation_id, booking_id, appoint_date, time_mode, slot_id, time_start, time_end, purpose_id, purpose_text, instructions, provider, note, status, link_code, confirm_sent_at, reminder_sent_at, reminder_attempted_at, name_from_his, last_send_error, called_at, called_by, created_by, created_at, updated_at";

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
}

async function conversationInfo(conversationId: string): Promise<ConversationInfo | null> {
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations")
    .select("id, status, sensitive, tags, archived, contacts(external_id, display_name, language), channels(type)")
    .eq("id", conversationId).maybeSingle();
  if (!conv) return null;
  const contact = (Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts) as { external_id: string; display_name: string | null; language: string } | null;
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
  };
}

/** แชทล่าสุดที่ผูกกับ HN นี้ */
export async function findLinkedConversation(hn: string | null | undefined): Promise<string | null> {
  if (!hn?.trim()) return null;
  const { data } = await supabaseAdmin().from("patient_links").select("conversation_id, linked_at")
    .eq("hn", hn.trim()).order("linked_at", { ascending: false }).limit(1).maybeSingle();
  return (data?.conversation_id as string | undefined) ?? null;
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
export interface DeliveryResult { sent: boolean; via?: ChannelType; error?: string }

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
async function pushAppointment(info: ConversationInfo, via: "line" | "facebook" | "instagram", input: MessageInput, replyToken?: string): Promise<string | null> {
  if (via === "line") {
    await lineSendMessages(info.externalId, [appointmentFlex(input)], replyToken);
    return null;
  }
  return metaSendMessage(info.externalId, metaAppointmentMessage(via, input));
}

/**
 * ส่งข้อความนัดหนึ่งครั้ง บันทึกผลลง appointments และ appointment_events
 * ส่งไม่ได้ (นอก 24 ชม., ไม่มีแชท) บันทึกเป็น "ส่งไม่ได้-ต้องโทร" ไม่ throw
 */
export async function deliverAppointment(appt: Appointment, kind: MessageKind, opts: { actor?: Actor; staffId?: string | null; replyToken?: string; now?: number } = {}): Promise<DeliveryResult> {
  const db = supabaseAdmin();
  const actor = opts.actor ?? "system";
  if (!appt.conversation_id) {
    await logAppointmentEvent(appt.id, "send_skipped", actor, { staffId: opts.staffId, detail: { kind, reason: "no_chat" } });
    return { sent: false, error: DELIVERY_FAILURE_TEXT.no_chat };
  }
  const info = await conversationInfo(appt.conversation_id);
  const delivery = chooseDelivery({ channelType: info?.channelType ?? null, lastInboundAt: info?.lastInboundAt ?? null, archived: info?.archived, now: opts.now });
  if (!info || !delivery.ok) {
    const error = DELIVERY_FAILURE_TEXT[delivery.ok ? "no_chat" : delivery.reason];
    await db.from("appointments").update({ last_send_error: error, updated_at: nowIso() }).eq("id", appt.id);
    await logAppointmentEvent(appt.id, "send_failed", actor, { staffId: opts.staffId, channel: info?.channelType ?? null, detail: { kind, reason: delivery.ok ? "no_chat" : delivery.reason } });
    return { sent: false, via: info?.channelType, error };
  }
  const [settings, clinic] = await Promise.all([loadAppointmentSettings(), clinicName()]);
  const input = messageInput(appt, kind, info, settings, clinic);
  try {
    const mid = await pushAppointment(info, delivery.via, input, opts.replyToken);
    await insertSystemMessage(info.id, { direction: "out", body: appointmentText(input), language: input.lang, externalId: mid });
  } catch (e) {
    const error = `ส่งไม่สำเร็จ-ต้องโทร: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`;
    console.error("appointment send failed", delivery.via, kind);
    await db.from("appointments").update({ last_send_error: error, updated_at: nowIso() }).eq("id", appt.id);
    await logAppointmentEvent(appt.id, "send_failed", actor, { staffId: opts.staffId, channel: delivery.via, detail: { kind, error } });
    return { sent: false, via: delivery.via, error };
  }
  const at = nowIso();
  const sentField = kind === "reminder" ? { reminder_sent_at: at } : kind === "cancelled" ? {} : { confirm_sent_at: at };
  await db.from("appointments").update({ ...sentField, last_send_error: null, updated_at: at }).eq("id", appt.id);
  await logAppointmentEvent(appt.id, "sent", actor, { staffId: opts.staffId, channel: delivery.via, detail: { kind } });
  return { sent: true, via: delivery.via };
}

/** ข้อความตอบสั้นๆ หลังกดปุ่มหรือส่งรหัส ใช้ replyToken ของ LINE ก่อนเพื่อไม่กินโควตา */
async function replyText(info: ConversationInfo, text: string, replyToken?: string) {
  if (info.channelType === "line") {
    await lineSendMessages(info.externalId, [{ type: "text", text }], replyToken);
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
    provider: clip(b.provider, 120) || null,
    note: clip(b.note, 1000) || null,
  };
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
    if (!error && data) return data as unknown as Appointment;
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

  const appointment = await insertWithCode({
    ...fields, name_from_his: b.name_from_his === true, source: "docdesk", conversation_id: conversationId, booking_id: bookingId,
    status: "scheduled", created_by: staffId, updated_at: nowIso(),
  });
  await logAppointmentEvent(appointment.id, "created", "staff", { staffId, detail: { from: fromChat ? "chat" : "appointments", booking_id: bookingId } });

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

  const delivery = await deliverAppointment(appointment, "new", { actor: "staff", staffId, now });
  return { appointment: (await loadAppointment(appointment.id)) ?? appointment, delivery };
}

/** แก้วันหรือเวลา = ส่งข้อความนัดใหม่อัตโนมัติ และเริ่มรอบเตือนใหม่ */
export async function updateAppointment(id: string, b: AppointmentInput, staffId: string, now = Date.now()): Promise<{ appointment: Appointment; delivery: DeliveryResult | null }> {
  const current = await loadAppointment(id);
  if (!current) throw new AppointmentError("ไม่พบนัด", 404);
  if (!OPEN_STATUSES.includes(current.status)) throw new AppointmentError("นัดนี้ปิดไปแล้ว แก้ไม่ได้", 409);
  const fields = await resolveFields({
    hn: current.hn, patient_name: current.patient_name, phone: current.phone, appoint_date: current.appoint_date,
    time_mode: current.time_mode, slot_id: current.slot_id, time_start: current.time_start.slice(0, 5),
    purpose_id: current.purpose_id, purpose_text: current.purpose_text, instructions: current.instructions,
    provider: current.provider, note: current.note,
    ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)),
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
  await logAppointmentEvent(id, moved ? "rescheduled" : "edited", "staff", {
    staffId, detail: moved ? { from: `${current.appoint_date} ${timeShort(current)}`, to: `${fields.appoint_date} ${timeShort(fields)}` } : {},
  });
  const updated = (await loadAppointment(id)) as Appointment;
  const delivery = moved ? await deliverAppointment(updated, "changed", { actor: "staff", staffId, now }) : null;
  return { appointment: (await loadAppointment(id)) ?? updated, delivery };
}

export async function cancelAppointment(id: string, staffId: string): Promise<{ delivery: DeliveryResult }> {
  const current = await loadAppointment(id);
  if (!current) throw new AppointmentError("ไม่พบนัด", 404);
  if (!OPEN_STATUSES.includes(current.status)) throw new AppointmentError("นัดนี้ปิดไปแล้ว", 409);
  await supabaseAdmin().from("appointments").update({ status: "cancelled", updated_at: nowIso() }).eq("id", id);
  await logAppointmentEvent(id, "cancelled", "staff", { staffId });
  return { delivery: await deliverAppointment({ ...current, status: "cancelled" }, "cancelled", { actor: "staff", staffId }) };
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
  // ปุ่มส่งถึงแชทนี้เท่านั้น ถ้าไม่ตรงคือข้อมูลปลอมหรือนัดถูกย้ายไปแชทอื่น
  if (!appt || appt.conversation_id !== conversationId) return "ignored";
  if (!OPEN_STATUSES.includes(appt.status) || isPast(appt, now)) {
    await replyText(info, REPLY_TEXT[lang].closed, ref.replyToken);
    return "ignored";
  }

  if (parsed.action === "confirm") {
    await db.from("appointments").update({ status: "confirmed", updated_at: nowIso() }).eq("id", appt.id);
    await logAppointmentEvent(appt.id, "confirmed", "customer", { channel: info.channelType });
    await replyText(info, REPLY_TEXT[lang].confirmed, ref.replyToken);
    return "confirmed";
  }

  await db.from("appointments").update({ status: "reschedule_requested", called_at: null, called_by: null, updated_at: nowIso() }).eq("id", appt.id);
  await logAppointmentEvent(appt.id, "reschedule_requested", "customer", { channel: info.channelType });
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

/** "ยืนยันนัด #XXXXXX": ผูกนัดกับแชท ผูกแชทกับ HN แล้วส่งข้อความนัดพร้อมปุ่มทันที */
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
  await db.from("appointments").update({ conversation_id: conversationId, last_send_error: null, updated_at: nowIso() }).eq("id", appt.id);
  await logAppointmentEvent(appt.id, "linked", "customer", { channel: info.channelType, detail: { code } });
  if (appt.hn) {
    // นัดอื่นของคนไข้คนเดียวกันที่ยังไม่มีแชท ได้ข้อความเตือนด้วย
    const { data: others } = await db.from("appointments").select("id, status, conversation_id").eq("hn", appt.hn).is("conversation_id", null);
    const ids = ((others ?? []) as { id: string; status: string }[]).filter((o) => OPEN_STATUSES.includes(o.status as Appointment["status"])).map((o) => o.id);
    if (ids.length) await db.from("appointments").update({ conversation_id: conversationId, updated_at: nowIso() }).in("id", ids);
  }
  await deliverAppointment({ ...appt, conversation_id: conversationId }, "linked", { actor: "customer", replyToken: ref.replyToken, now });
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
    const r = await deliverAppointment(appt, "reminder", { actor: "system", now });
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
  const delivery = chooseDelivery({ channelType: info?.channelType ?? null, lastInboundAt: info?.lastInboundAt ?? null, archived: info?.archived, now });
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
}

/** ค้นหาใช้ใน PostgREST or() จึงตัดตัวอักษรที่มีความหมายในไวยากรณ์ออก */
const searchTerm = (q: string) => q.replace(/[,()%*\:"']/g, " ").trim().slice(0, 60);

/** purpose: id ของ preset หรือ "none" = ไม่ได้เลือก preset */
export async function listAppointments(opts: { tab: "today" | "tomorrow" | "all"; q?: string; from?: string | null; to?: string | null; purpose?: string | null }, now = Date.now()): Promise<AppointmentListRow[]> {
  const today = bangkokToday(now);
  let query = supabaseAdmin().from("appointments")
    .select(`${APPOINTMENT_COLUMNS}, conversations(channels(type), contacts(display_name, platform_name, hn, patient_full_name))`);
  if (opts.tab === "today") query = query.eq("appoint_date", today);
  else if (opts.tab === "tomorrow") query = query.eq("appoint_date", addDays(today, 1));
  else {
    query = query.gte("appoint_date", opts.from || today);
    if (opts.to) query = query.lte("appoint_date", opts.to);
  }
  const q = searchTerm(opts.q ?? "");
  if (q) query = query.or(`patient_name.ilike.%${q}%,hn.ilike.%${q}%,phone.ilike.%${q}%`);
  if (opts.purpose === "none") query = query.is("purpose_id", null);
  else if (opts.purpose && UUID.test(opts.purpose)) query = query.eq("purpose_id", opts.purpose);
  const { data } = await query.order("appoint_date").order("time_start").limit(500);
  return ((data ?? []) as unknown as (Appointment & { conversations: unknown })[]).map(({ conversations, ...a }) => {
    const conv = (Array.isArray(conversations) ? conversations[0] : conversations) as { channels?: { type: ChannelType } | { type: ChannelType }[]; contacts?: ContactNameFields | ContactNameFields[] } | null;
    const channel = conv?.channels ? (Array.isArray(conv.channels) ? conv.channels[0] : conv.channels) : null;
    const contact = conv?.contacts ? (Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts) : null;
    return { ...a, channel: channel?.type ?? null, chat_name: contact ? contactName(contact) : null };
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
export async function appointmentFormData(hn: string | null, now = Date.now()) {
  const db = supabaseAdmin();
  const today = bangkokToday(now);
  const [{ data: recent }, linked, schedule, presets] = await Promise.all([
    db.from("appointments").select("purpose_id, purpose_text, provider, created_at").order("created_at", { ascending: false }).limit(500),
    findLinkedConversation(hn),
    loadClinicSchedule(today, addDays(today, 400)),
    loadPurposes(),
  ]);
  const rows = (recent ?? []) as { purpose_id: string | null; purpose_text: string | null; provider: string | null }[];
  let linkedChannel: ChannelType | null = null;
  if (linked) {
    const info = await conversationInfo(linked);
    linkedChannel = info?.channelType ?? null;
  }
  return {
    presets: presets.filter((p) => p.active),
    // เหตุผลที่พิมพ์เอง (ไม่ใช่ preset) ใช้เป็น autocomplete ของ "อื่นๆ"
    purposeHistory: frequentTexts(rows.filter((r) => !r.purpose_id || !presets.some((p) => p.id === r.purpose_id && p.name === r.purpose_text)).map((r) => r.purpose_text)),
    providers: frequentTexts(rows.map((r) => r.provider), 20),
    linked: linked ? { conversation_id: linked, channel: linkedChannel } : null,
    schedule,
  };
}

export async function appointmentSlip(id: string) {
  const appt = await loadAppointment(id);
  if (!appt) return null;
  const [settings, clinic] = await Promise.all([loadAppointmentSettings(), clinicName()]);
  return {
    appointment: appt,
    clinic,
    phone: settings.clinic_phone,
    address: settings.clinic_address,
    qrUrl: lineOaMessageUrl(settings.line_oa_id, appt.link_code),
  };
}

export async function appointmentEvents(id: string) {
  const { data } = await supabaseAdmin().from("appointment_events").select("id, kind, actor, staff_id, channel, detail, created_at")
    .eq("appointment_id", id).order("created_at");
  return data ?? [];
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
export async function appointmentTabCounts(now = Date.now()) {
  const today = bangkokToday(now);
  const tomorrow = addDays(today, 1);
  const { data } = await supabaseAdmin().from("appointments").select("appoint_date, status")
    .gte("appoint_date", today).neq("status", "cancelled");
  const rows = (data ?? []) as { appoint_date: string }[];
  return {
    today: rows.filter((r) => r.appoint_date === today).length,
    tomorrow: rows.filter((r) => r.appoint_date === tomorrow).length,
    all: rows.length,
  };
}

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
