"use client";

import { thaiDateTime } from "@/lib/time-format";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { useLiveChannel } from "@/lib/use-live-channel";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { LANGUAGE_NAME } from "@/lib/translate-names";
import { staffInitial } from "@/lib/assignment";
import { isWaitingForReply, nextOpenChat, queueOf, queueSections, waitBadge, type InboxFilter, type InboxSection } from "@/lib/case-flow";
import type { InboxListResult, QueueRow } from "@/lib/inbox-list";
import { SENSITIVE_TAG } from "@/lib/sensitive-rules";
import { BADGE_EVENT, PRESENCE_BEAT_MS } from "@/lib/push-rules";
import { DEFAULT_TAG_COLOR, type Tag } from "@/lib/tags";
import { formatFileSize, isPdfName, MAX_FILE_BYTES } from "@/lib/files";
import { MAX_UPLOAD_BYTES, uploadStaffImage } from "@/lib/upload-client";
import { TagChip } from "../tag-chip";
import { publishChatCounts, useChatCountsOwner, type ChatCounts } from "../chat-badge";
import { chatBundle, forgetChatBundle } from "@/lib/chat-bundle";
import { ArchiveMergeBar } from "./archive-merge-bar";
import { AssigneeControl } from "./assignee-control";
import { contactLabel, contactName, staffMayRename } from "@/lib/patient-name";
import { AppointmentsBlock } from "./appointments-block";
import { LabResultsBlock } from "./lab-results-block";
import { BookingsBlock, type BookingCardRow } from "./booking-card";
import { Icon } from "../icons";
import { CloseCasePopup } from "./close-case-popup";
import { TagPicker } from "./tag-picker";
import { TeamPanel } from "./team-panel";
import { CustomerCard } from "./customer-card";
import { latestFacts, useVisitHistory, VisitHistoryBlock } from "./visit-history";
import { WebBookingCard } from "./web-booking-card";
import { MobileChatTabs, useMobileTyping, type ApptSummary, type MobileTab } from "./mobile-chat";
import {
  AI_MODE_HINT, AI_MODE_LABEL, CHANNEL_LABEL,
  type AiMode, type Conversation, type Message, type SuggestionOption, type SuggestionResult,
} from "@/lib/types";

/** ยังไม่ได้รัน migration 063: realtime เปลี่ยนติดกันหลายครั้ง → ถามรายการหน้าแรกใหม่ครั้งเดียว */
const WORK_DEBOUNCE_MS = 2_000;
/** แถวต่อหน้า (เลื่อนลงสุด = โหลดหน้าถัดไป) */
const PAGE_SIZE = 30;
/** โหลดรายการทั้งก้อนใหม่ไม่บ่อยกว่านี้ (นอกจากเปลี่ยนตัวกรอง/ค้นหา) — ระหว่างนั้น realtime แก้เฉพาะแถว */
const FULL_RELOAD_MS = 55_000;
/** ฟิลด์ที่ทำให้แชทย้ายช่วง หรือมีงานค้างเปลี่ยน */
const QUEUE_FIELDS = ["status", "last_direction", "booking_pending", "open_tasks", "ai_review_at", "archived"] as const;
type ConvPatch = Partial<QueueRow> & { ai_review_at?: string | null };

/** รวมแถวใหม่เข้ารายการ (id ซ้ำ = แทนที่) */
const mergeRows = (prev: QueueRow[], rows: QueueRow[]) => {
  const byId = new Map(prev.map((c) => [c.id, c]));
  for (const r of rows) byId.set(r.id, r);
  return [...byId.values()];
};
const queueChanged = (cur: object, patch: object) =>
  QUEUE_FIELDS.some((k) => k in patch && ((patch as Record<string, unknown>)[k] ?? null) !== ((cur as Record<string, unknown>)[k] ?? null));
const bookingsToShow = (rows: BookingCardRow[]) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
  return rows.filter((b) => b.status === "ai_confirmed" || b.date >= today);
};

const SOURCE_LABEL: Record<SuggestionOption["source"], string> = {
  knowledge: "📚 ฐานข้อมูล",
  example: "💬 คำตอบเดิม",
  history: "🕘 ประวัติลูกค้า",
};

const timeTh = (iso: string) => thaiDateTime(iso);

interface StaffOption { id: string; display_name: string; active: boolean; role?: string; can_view_sensitive?: boolean }
interface AssignmentEntry { id: number; from_staff: string | null; to_staff: string | null; by_staff: string | null; created_at: string }
interface QuickMedia { id: string; title: string; preview_path: string; previewUrl?: string }
interface Attachment { file?: File; quick?: QuickMedia; previewUrl: string; name: string; kind?: "image" | "file"; size?: number }

const SIGNED_URL_SECONDS = 600;
/** แชทลับเบลอกลับเมื่อไม่ขยับนานเท่านี้ */
const SENSITIVE_IDLE_MS = 60_000;
/** รูปเข้าที่ยังโหลดไม่เสร็จนานเกินนี้ถือว่าล้มเหลว (เช่น function ถูกตัดก่อนโหลดเสร็จ) */
const IMAGE_LOADING_MAX_MS = 2 * 60 * 1000;

export function InboxClient({ me }: { me: { id: string; role: "admin" | "agent"; displayName: string; canViewSensitive: boolean; sensitiveAcked: boolean } }) {
  const isAdmin = me.role === "admin";
  const sb = useMemo(() => supabaseBrowser(), []);
  const [convs, setConvs] = useState<QueueRow[]>([]);
  // รายการเดียวแบบคิวงาน 3 ช่วง (รอตอบ / งานค้าง / ล่าสุด) · ปุ่มกรอง ทั้งหมด / รอตอบ / งานค้าง / ของฉัน
  const [qfilter, setQfilter] = useState<InboxFilter>("all");
  // ตัวเลขปุ่มกรอง (ทั้งหมดใน server ไม่ใช่แค่ที่โหลดมา) · หน้าถัดไป · โหมดของ server (queue = migration 063)
  const [qcounts, setQcounts] = useState({ waiting: 0, work: 0, mine: 0, unassigned: 0 });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const modeRef = useRef<InboxListResult["mode"]>("queue");
  const badgeRef = useRef({ waiting: 0, work: 0, total: 0 });
  const qfilterRef = useRef<InboxFilter>("all");
  qfilterRef.current = qfilter;
  const convsRef = useRef<QueueRow[]>([]);
  convsRef.current = convs;
  // หน้าแชทเป็นเจ้าของตัวเลข badge เมนูแชท (badge ไม่ยิงเองซ้ำ)
  useChatCountsOwner();
  const [reloadTick, setReloadTick] = useState(0);
  const [confirmSplit, setConfirmSplit] = useState(false);
  /** null = ไม่ได้แก้ชื่อ */
  const [editingName, setEditingName] = useState<string | null>(null);
  const [history, setHistory] = useState<AssignmentEntry[]>([]);
  const [search, setSearch] = useState("");
  const searchRef = useRef("");
  const loadSeq = useRef(0);
  const [closing, setClosing] = useState(false);
  // ไม่มีสิทธิ์: เห็นแค่ว่ามีแชทลับรอตอบ
  const [maskedWaiting, setMaskedWaiting] = useState<{ key: string; waiting_since: string | null }[]>([]);
  const [acked, setAcked] = useState(me.sensitiveAcked);
  const ackedRef = useRef(acked);
  ackedRef.current = acked;
  const [ackChecked, setAckChecked] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [confirmUntag, setConfirmUntag] = useState(false);
  const [bookings, setBookings] = useState<BookingCardRow[]>([]);
  // ข้อความขอเลื่อนที่อยู่ในช่องพิมพ์: ส่งแล้วจึงยกเลิกนัดนี้
  const [cancelBookingId, setCancelBookingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // มือถือ: ห้องแชทแบ่งเป็นแท็บ แชท · นัด · งาน · คอมเมนต์ · ข้อมูลคนไข้ (จอใหญ่แสดงทุกส่วนพร้อมกันเหมือนเดิม)
  const [mtab, setMtab] = useState<MobileTab>("chat");
  const [apptSummary, setApptSummary] = useState<ApptSummary | null>(null);
  const visitHistory = useVisitHistory(selectedId, apptSummary?.patient?.hn);
  const [noteCount, setNoteCount] = useState(0);
  const [firstTask, setFirstTask] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestion, setSuggestion] = useState<SuggestionResult | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<number | null>(null);
  const [rawMode, setRawMode] = useState(false); // ส่งตามที่พิมพ์ ไม่แปล
  // พับกล่องคำตอบแนะนำ (จำต่อเครื่อง) · พับแล้วเหลือแค่หัวข้อ
  const [suggestOpen, setSuggestOpen] = useState(true);
  useEffect(() => { try { if (localStorage.getItem("docdesk:suggest-open") === "0") setSuggestOpen(false); } catch {} }, []);
  const toggleSuggest = () => setSuggestOpen((v) => { try { localStorage.setItem("docdesk:suggest-open", v ? "0" : "1"); } catch {} return !v; });
  const [sending, setSending] = useState(false);
  // ส่งไม่ออก (เช่น โควตา LINE หมด): แสดงค้างไว้ ไม่หายเงียบ
  const [sendError, setSendError] = useState("");
  useEffect(() => { setSendError(""); }, [selectedId]);
  const [globalMode, setGlobalMode] = useState<AiMode>("assist");
  const [toast, setToast] = useState("");
  const [, setTick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [caption, setCaption] = useState("");
  const [quickMedia, setQuickMedia] = useState<QuickMedia[]>([]);
  const [dragging, setDragging] = useState(false);

  const [staffList, setStaffList] = useState<StaffOption[]>([]);
  const staffName = useMemo(() => new Map(staffList.map((s) => [s.id, s.display_name])), [staffList]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const tagFilterRef = useRef<string[]>([]);
  tagFilterRef.current = tagFilter;
  // แชทที่เปิดอยู่แต่ไม่ตรงตัวกรอง (เช่น เพิ่งเอาแท็กที่กรองอยู่ออก) ต้องไม่ปิดห้องแชทกะทันหัน
  const [openConv, setOpenConv] = useState<Conversation | null>(null);

  const selected = convs.find((c) => c.id === selectedId) ?? (openConv?.id === selectedId ? openConv : null);
  const tagColor = useMemo(() => new Map(tags.map((t) => [t.name, t.color])), [tags]);
  const customerLang = selected?.contacts?.language ?? "th";
  // ใครติดแท็กแต่ละอัน ใช้แสดงเครื่องหมาย AI (tag_events อ่านได้เฉพาะ admin จึงถามผ่าน API)
  const [tagSources, setTagSources] = useState<Record<string, string>>({});
  const tagKey = selected ? `${selected.id}:${selected.tags.join(",")}` : "";
  const loadTagSources = useCallback((id: string) => {
    fetch(`/api/conversations/${id}/tags`).then((r) => (r.ok ? r.json() : { sources: {} }))
      .then((j) => { if (selectedRef.current === id) setTagSources((j.sources ?? {}) as Record<string, string>); })
      .catch(() => { if (selectedRef.current === id) setTagSources({}); });
  }, []);
  const prevTagKey = useRef("");
  useEffect(() => {
    if (!tagKey) return;
    const prev = prevTagKey.current;
    prevTagKey.current = tagKey;
    const id = tagKey.split(":")[0];
    // เพิ่งเปิดแชท: ได้มากับข้อมูลห้องแชทแล้ว · โหลดเองเฉพาะเมื่อแท็กของแชทเดิมเปลี่ยน
    if (!prev.startsWith(`${id}:`) || prev === tagKey) return;
    loadTagSources(id);
  }, [tagKey, loadTagSources]);

  // ---------- โหลดรายการแชท ----------
  // server ดึงครั้งเดียวต่อหน้า (/api/inbox/list ทีละ 30 แถว) · โหลดทั้งก้อน: เปิดหน้า · เปลี่ยนตัวกรอง/ค้นหา · ทุก ~60 วิ
  // นอกนั้น realtime แก้เฉพาะแถวที่เปลี่ยน (แถวบอกช่วงของตัวเองมาด้วย)
  const lastFull = useRef(0);
  const fetchList = useCallback(async (extra: Record<string, string>) => {
    const u = new URLSearchParams({ filter: qfilterRef.current, ...extra });
    const term = searchRef.current.trim();
    if (term) u.set("q", term);
    if (tagFilterRef.current.length) u.set("tags", tagFilterRef.current.join(","));
    return (await fetch(`/api/inbox/list?${u}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as InboxListResult | null;
  }, []);
  const applyCounts = useCallback((j: InboxListResult) => {
    modeRef.current = j.mode;
    setQcounts(j.counts);
    badgeRef.current = j.badge;
    publishChatCounts(j.badge);
  }, []);
  const loadConvs = useCallback(async () => {
    const seq = ++loadSeq.current;
    lastFull.current = Date.now();
    // โหลดใหม่เท่าที่เลื่อนดูไว้แล้ว (ไม่เด้งกลับขึ้นบน)
    const limit = Math.min(200, Math.max(PAGE_SIZE, convsRef.current.length));
    const j = await fetchList({ limit: String(limit) });
    if (!j || seq !== loadSeq.current) return; // ผลของการค้นหาเก่าที่ตอบช้าต้องไม่ทับผลล่าสุด
    applyCounts(j);
    setConvs(j.rows);
    setNextCursor(j.next);
    const open = selectedRef.current;
    if (open && !j.rows.some((c) => c.id === open)) {
      const one = await fetchList({ id: open });
      setOpenConv((one?.rows[0] as Conversation | undefined) ?? null);
    }
  }, [fetchList, applyCounts]);

  // เลื่อนลงสุด: หน้าถัดไป
  const loadingMore = useRef(false);
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore.current) return;
    loadingMore.current = true;
    const seq = loadSeq.current;
    const j = await fetchList({ cursor: nextCursor, limit: String(PAGE_SIZE) });
    loadingMore.current = false;
    if (!j || seq !== loadSeq.current) return;
    setConvs((prev) => mergeRows(prev, j.rows));
    setNextCursor(j.next);
  }, [nextCursor, fetchList]);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = moreRef.current;
    if (!el || !nextCursor) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [nextCursor, loadMore]);

  // ยังไม่ได้รัน migration 063: งานค้างคำนวณที่ server ตอนขอรายการ → ขอหน้าแรกใหม่ (รวมการเปลี่ยนแปลงติดกัน)
  // มี 063 แล้ว: trigger คำนวณช่วงใหม่ลงแถว realtime ส่งมาเอง ไม่ต้องขออะไรเพิ่ม
  const workTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleWork = useCallback(() => {
    if (modeRef.current === "queue") return;
    if (workTimer.current) clearTimeout(workTimer.current);
    workTimer.current = setTimeout(async () => {
      workTimer.current = null;
      const seq = loadSeq.current;
      const j = await fetchList({ limit: String(PAGE_SIZE) });
      if (!j || seq !== loadSeq.current) return;
      applyCounts(j);
      setConvs((prev) => mergeRows(prev, j.rows));
    }, WORK_DEBOUNCE_MS);
  }, [fetchList, applyCounts]);
  useEffect(() => () => { if (workTimer.current) clearTimeout(workTimer.current); }, []);

  // แถวย้ายช่วง: ปรับตัวเลขปุ่มกรอง + badge ในเครื่องทันที (รอบโหลดเต็มถัดไปแก้ให้ตรงอีกที)
  const shiftCount = useCallback((from: InboxSection, to: InboxSection) => {
    if (from === to) return;
    const d = (k: "waiting" | "work", c: { waiting: number; work: number }) => (from === k ? -1 : 0) + (to === k ? 1 : 0) + c[k];
    setQcounts((c) => ({ ...c, waiting: Math.max(0, d("waiting", c)), work: Math.max(0, d("work", c)) }));
    const b = badgeRef.current;
    const nb = { waiting: Math.max(0, d("waiting", b)), work: Math.max(0, d("work", b)) };
    badgeRef.current = { ...nb, total: nb.waiting + nb.work };
    publishChatCounts(badgeRef.current);
  }, []);

  /** แก้แถวในหน้าจอทันที (การกระทำในเครื่องนี้ / realtime) ไม่ต้องโหลดรายการใหม่ */
  const patchLocal = useCallback((id: string, patch: ConvPatch) => {
    const cur = convsRef.current.find((c) => c.id === id);
    const apply = <R extends Conversation>(c: R) => ({ ...c, ...patch, contacts: patch.contacts ?? c.contacts, channels: c.channels }) as R;
    if (cur) {
      const next = apply(cur);
      convsRef.current = convsRef.current.map((c) => (c.id === id ? next : c));
      shiftCount(queueOf(cur), queueOf(next));
    }
    setConvs((prev) => prev.map((c) => (c.id === id ? apply(c) : c)));
    setOpenConv((o) => (o?.id === id ? apply(o) : o));
    if (cur && queueChanged(cur, patch)) scheduleWork();
  }, [scheduleWork, shiftCount]);

  // realtime ของ conversations: แก้เฉพาะแถวที่เปลี่ยน ห้ามโหลดทั้งก้อน
  const fetchingRow = useRef(new Set<string>());
  const onConvChange = useCallback((p: { eventType?: string; new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
    if (p.eventType === "DELETE") {
      const id = p.old?.id as string | undefined;
      const cur = id ? convsRef.current.find((c) => c.id === id) : null;
      if (id && cur) { setConvs((prev) => prev.filter((c) => c.id !== id)); shiftCount(queueOf(cur), "recent"); }
      return;
    }
    const n = (p.new ?? {}) as ConvPatch & { id?: string };
    if (!n.id) return;
    const id = n.id;
    const tagsOk = (t?: string[]) => tagFilterRef.current.every((x) => (t ?? []).includes(x));
    const cur = convsRef.current.find((c) => c.id === id);
    if (cur) {
      const next = { ...cur, ...n };
      // แชทเปิดที่ถูกย้ายเป็นแชทเก่า / ไม่ตรงแท็กที่กรองแล้ว: เอาออก (แชทที่เปิดดูอยู่ไม่ปิดกะทันหัน)
      if (id !== selectedRef.current && ((next.status === "open" && next.archived) || !tagsOk(next.tags))) {
        convsRef.current = convsRef.current.filter((c) => c.id !== id);
        setConvs((prev) => prev.filter((c) => c.id !== id));
        shiftCount(queueOf(cur), "recent");
        if (queueChanged(cur, n)) scheduleWork();
        return;
      }
      patchLocal(id, n);
      return;
    }
    setOpenConv((o) => (o?.id === id ? ({ ...o, ...n, contacts: o.contacts, channels: o.channels } as Conversation) : o));
    // แชทใหม่ / ยังไม่อยู่ในรายการ: ขอแถวเดียว (ได้ตัวเลขล่าสุดมาด้วย) · ค้นหาอยู่ = รอรอบโหลดเต็ม
    if (searchRef.current.trim() || !tagsOk(n.tags) || (n.status === "open" && n.archived) || fetchingRow.current.has(id)) return;
    if (qfilterRef.current === "mine" && n.assigned_to !== me.id) return;
    if (qfilterRef.current === "unassigned" && n.assigned_to) return;
    // ช่วงล่าสุดที่ยังเลื่อนไม่ถึง: ไม่ต้องดึงมาแทรก
    if (n.queue === "recent" && !(n.status === "open" && n.last_direction === "in") && nextCursor) return;
    fetchingRow.current.add(id);
    fetchList({ id }).then((j) => {
      fetchingRow.current.delete(id);
      if (!j) return;
      applyCounts(j);
      if (j.rows.length) setConvs((prev) => mergeRows(prev, j.rows));
    });
  }, [patchLocal, scheduleWork, shiftCount, fetchList, applyCounts, nextCursor, me.id]);

  const loadBookings = useCallback(async (convId: string) => {
    const { data } = await sb.from("bookings").select('id, service, "date", "time", name, phone, status')
      .eq("conversation_id", convId).neq("status", "cancelled").order("date").order("time");
    if (selectedRef.current !== convId) return;
    setBookings(bookingsToShow((data ?? []) as unknown as BookingCardRow[]));
  }, [sb]);

  const loadTags = useCallback(async () => {
    const { data } = await sb.from("tags").select("id, name, color, group, sort, active").order("sort").order("name");
    setTags((data ?? []) as Tag[]);
  }, [sb]);

  useEffect(() => { loadConvs(); }, [tagFilter, qfilter, loadConvs]);

  // แถวที่ไม่มีสิทธิ์ไม่ส่ง realtime มาให้ จึงต้องถามซ้ำเอง
  useEffect(() => {
    if (me.canViewSensitive) return;
    const load = () => sb.rpc("masked_sensitive_waiting").then(({ data }) => setMaskedWaiting((data ?? []) as { key: string; waiting_since: string | null }[]));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [sb, me.canViewSensitive]);

  // ลิงก์จากหน้านัดหมาย
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("c");
    if (id) setSelectedId(id);
  }, []);


  // ค้นหา: โหลดใหม่เมื่อคำค้นเปลี่ยนจริงเท่านั้น (ตอนเปิดหน้าไม่โหลดซ้ำ)
  const prevSearch = useRef("");
  useEffect(() => {
    searchRef.current = search;
    if (search === prevSearch.current) return;
    prevSearch.current = search;
    const wait = setTimeout(() => loadConvs(), 300);
    return () => clearTimeout(wait);
  }, [search, loadConvs]);

  const loadSuggestion = useCallback(async (convId: string) => {
    const { data } = await sb.from("suggestions").select("id, options, needs_human, suggested_tags")
      .eq("conversation_id", convId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    setSuggestion(data ? { id: data.id, options: data.options as SuggestionOption[], needs_human: data.needs_human, suggested_tags: data.suggested_tags as string[] } : null);
  }, [sb]);

  const loadHistory = useCallback((convId: string) => {
    sb.from("assignment_log").select("id, from_staff, to_staff, by_staff, created_at")
      .eq("conversation_id", convId).order("created_at", { ascending: false }).limit(20)
      .then(({ data }) => { if (selectedRef.current === convId) setHistory((data ?? []) as AssignmentEntry[]); });
  }, [sb]);

  // error ห้ามทำให้หน้าแชทพัง ฝั่ง server log ไว้แล้ว
  // server ล้าง unread_count + "AI ตอบแล้ว รอตรวจ" ให้ในครั้งเดียว · หน้าจอแก้ทันที ไม่รอ realtime
  const markRead = useCallback((convId: string) => {
    patchLocal(convId, { unread_count: 0, ai_review_at: null });
    fetch(`/api/conversations/${convId}/read`, { method: "POST" })
      .then(() => window.dispatchEvent(new Event(BADGE_EVENT))) // ตัวเลขบนไอคอนแอปลดตาม
      .catch(() => {});
  }, [patchLocal]);

  // บอก server ว่ากำลังเปิดแชทไหน (หน้าจอเปิดอยู่) → ไม่ส่ง push ของแชทนี้ให้เราซ้ำ · ทุก 30 วิ หมดอายุเองถ้าปิดแอป
  useEffect(() => {
    const send = (id: string | null) => {
      const body = JSON.stringify({ conversationId: id });
      if (!id && navigator.sendBeacon) { navigator.sendBeacon("/api/push/presence", new Blob([body], { type: "application/json" })); return; }
      fetch("/api/push/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
    };
    const beat = () => send(selectedId && document.visibilityState === "visible" ? selectedId : null);
    if (selectedId) beat();
    const t = selectedId ? setInterval(beat, PRESENCE_BEAT_MS) : null;
    document.addEventListener("visibilitychange", beat);
    return () => {
      if (t) clearInterval(t);
      document.removeEventListener("visibilitychange", beat);
      if (selectedId) send(null);
    };
  }, [selectedId]);

  // สร้างคำแนะนำเมื่อเจ้าหน้าที่ดูแชทอยู่ server จะไม่เรียก LLM ซ้ำถ้ามีของข้อความล่าสุดแล้ว
  const ensureSuggestion = useCallback(async (convId: string, quiet = false) => {
    if (!quiet) setSuggesting(true);
    try {
      const res = await fetch(`/api/conversations/${convId}/suggest?ensure=1`, { method: "POST" });
      if (!res.ok || selectedRef.current !== convId) return;
      const s = (await res.json()) as SuggestionResult;
      if (s.options?.length) setSuggestion((prev) => (prev?.id === s.id ? prev : s));
    } catch {
      // ยังกด "แนะนำใหม่" เองได้
    } finally {
      if (!quiet) setSuggesting(false);
    }
  }, []);

  useEffect(() => {
    loadTags();
    sb.from("staff").select("id, display_name, active, role, can_view_sensitive").order("display_name")
      // ห้องยาไม่เห็นแชท จึงรับเคสหรืองานไม่ได้
      .then(({ data }) => setStaffList(((data ?? []) as StaffOption[]).filter((s) => s.role !== "pharmacy")));
    sb.from("quick_media").select("id, title, preview_path").order("created_at", { ascending: false }).then(async ({ data }) => {
      const rows = (data ?? []) as QuickMedia[];
      if (!rows.length) return;
      const { data: urls } = await sb.storage.from("quick-media").createSignedUrls(rows.map((r) => r.preview_path), 3600);
      setQuickMedia(rows.map((r, i) => ({ ...r, previewUrl: urls?.[i]?.signedUrl ?? undefined })));
    });
    sb.from("settings").select("value").eq("key", "ai_mode").maybeSingle()
      .then(({ data }) => data && setGlobalMode(data.value as AiMode));

    const t = setInterval(() => setTick((x) => x + 1), 15_000);
    // ข้อความเข้าตอนหน้าต่างไม่โฟกัส: แจ้งอ่านแล้วเมื่อเจ้าหน้าที่กลับมา (server กันเรียก API ซ้ำให้)
    const onFocus = () => {
      const id = selectedRef.current;
      if (!id) return;
      const c = convsRef.current.find((x) => x.id === id);
      if (c && !c.unread_count) return;
      markRead(id);
      ensureSuggestion(id, true);
    };
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [sb, loadConvs, loadTags]);

  // ข้อความที่พลาดไประหว่าง realtime หลุด: ดึงล่าสุดมารวม ไม่ล้างหน้าจอ (แชทที่เปิดอยู่ไม่กระพริบ)
  const refreshSelected = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return;
    const { data: conv } = await sb.from("conversations").select("sensitive").eq("id", id).maybeSingle();
    let rows: Message[] = [];
    if (conv?.sensitive) {
      if (!ackedRef.current) return;
      const res = await fetch(`/api/conversations/${id}/messages`);
      if (!res.ok) return;
      rows = ((await res.json()) as { messages: Message[] }).messages;
    } else {
      const { data, error } = await sb.from("messages").select("*").eq("conversation_id", id).order("created_at", { ascending: false }).limit(300);
      if (error) return;
      rows = ((data ?? []) as Message[]).reverse();
    }
    if (selectedRef.current !== id) return;
    setMessages((prev) => {
      const same = prev.length === rows.length && prev.every((m, i) => m.id === rows[i].id && m.read_by_customer_at === rows[i].read_by_customer_at && m.body_th === rows[i].body_th && m.starred === rows[i].starred && m.media_deleted_at === rows[i].media_deleted_at);
      return same ? prev : rows;
    });
    loadBookings(id);
  }, [sb, loadBookings]);

  useLiveChannel(sb, "inbox", (ch: RealtimeChannel) => ch
    .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, (p) => onConvChange(p as never))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => {
        const m = p.new as Message;
        if (m.imported) return; // ข้อความเก่า ต่อท้ายแล้วลำดับจะผิด
        if (m.conversation_id === selectedRef.current) {
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
          if (m.direction === "in") {
            if (document.hasFocus()) markRead(m.conversation_id);
            // รอให้ลูกค้าพิมพ์จบ แล้วค่อยสร้างครั้งเดียวจากทั้งชุด
            if (draftTimer.current) clearTimeout(draftTimer.current);
            draftTimer.current = setTimeout(() => {
              if (document.hasFocus() && selectedRef.current === m.conversation_id) ensureSuggestion(m.conversation_id);
            }, 8000);
          }
        }
      })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, (p) => {
        const m = p.new as Message;
        if (m.conversation_id === selectedRef.current) {
          setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...m } : x)));
        }
      })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, (p) => {
        // ส่งรูปไม่สำเร็จ แถวที่สร้างไว้ก่อนส่งถูกลบ
        setMessages((prev) => prev.filter((x) => x.id !== (p.old as { id: string }).id));
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, () => {
        if (selectedRef.current) loadBookings(selectedRef.current);
        scheduleWork();
      })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "suggestions" }, (p) => {
        const s = p.new as { id: string; conversation_id: string; options: SuggestionOption[]; needs_human: boolean; suggested_tags: string[] };
        if (s.conversation_id === selectedRef.current) {
          setSuggestion({ id: s.id, options: s.options, needs_human: s.needs_human, suggested_tags: s.suggested_tags });
          setChosen(null);
        }
      }),
  // ต่อใหม่ / กลับมาที่หน้าจอ / ทุก 60 วิ: โหลดเต็มไม่บ่อยกว่า FULL_RELOAD_MS
  () => {
    if (Date.now() - lastFull.current < FULL_RELOAD_MS) return;
    loadConvs(); refreshSelected();
  });

  // ---------- เลือกแชท ----------
  useEffect(() => {
    if (!selectedId) return;
    setClosing(false);
    setBookings([]);
    setCancelBookingId(null);
    setRevealed(false);
    setConfirmUntag(false);
    setConfirmSplit(false);
    setMessages([]);
    setText(""); setChosen(null); setSuggestion(null); setRawMode(false); setAttachment(null); setCaption("");
    if (draftTimer.current) clearTimeout(draftTimer.current);
    let stale = false;
    (async () => {
      // ข้อมูลทั้งห้องใน request เดียว (กล่องข้าง ๆ ใช้ผลเดียวกัน) · ส่วนที่ได้ไม่ครบ = โหลดเองตามเดิม
      const b = await chatBundle(selectedId);
      if (stale) return;
      const conv = b?.conv ?? (await sb.from("conversations").select("sensitive, archived").eq("id", selectedId).maybeSingle()).data;
      if (stale) return;
      if (conv?.sensitive) {
        // รอรับทราบข้อกำหนดก่อน ส่วนการเปิดผ่าน API เพื่อบันทึกประวัติ
        if (!acked) return;
        const res = await fetch(`/api/conversations/${selectedId}/messages`);
        if (stale || !res.ok) return;
        setMessages(((await res.json()) as { messages: Message[] }).messages);
      } else if (b?.messages) {
        setMessages(b.messages as Message[]);
      } else {
        // เอาล่าสุด 300 ข้อความ ประวัติที่นำเข้าต้องไม่ดันข้อความใหม่ตกหล่น
        const { data } = await sb.from("messages").select("*").eq("conversation_id", selectedId).order("created_at", { ascending: false }).limit(300);
        if (stale) return;
        setMessages(((data ?? []) as Message[]).reverse());
      }
      // แชทเก่าอ่านอย่างเดียว ไม่มีคำแนะนำหรือสถานะอ่านแล้ว
      if (b?.history) setHistory(b.history as AssignmentEntry[]); else loadHistory(selectedId);
      if (b?.tagSources) setTagSources(b.tagSources); else loadTagSources(selectedId);
      if (conv?.archived) return;
      if (b?.bookings) setBookings(bookingsToShow(b.bookings as BookingCardRow[])); else loadBookings(selectedId);
      if (b && b.suggestion !== undefined) {
        const sg = b.suggestion;
        setSuggestion(sg ? { id: sg.id, options: sg.options as SuggestionOption[], needs_human: sg.needs_human, suggested_tags: sg.suggested_tags as string[] } : null);
        ensureSuggestion(selectedId);
      } else loadSuggestion(selectedId).then(() => ensureSuggestion(selectedId));
      markRead(selectedId);
    })();
    return () => { stale = true; };
  }, [selectedId, acked, reloadTick, sb, loadSuggestion, loadBookings, markRead, ensureSuggestion, loadHistory, loadTagSources]);

  // เบลอกลับเมื่อไม่ขยับ หรือสลับไปหน้าต่างอื่น
  const isSensitive = !!convs.find((c) => c.id === selectedId)?.sensitive || (openConv?.id === selectedId && !!openConv?.sensitive);
  useEffect(() => {
    if (!isSensitive || !revealed) return;
    const hide = () => setRevealed(false);
    let idle = setTimeout(hide, SENSITIVE_IDLE_MS);
    const activity = () => { clearTimeout(idle); idle = setTimeout(hide, SENSITIVE_IDLE_MS); };
    const onVisibility = () => { if (document.visibilityState !== "visible") hide(); };
    const events = ["mousemove", "keydown", "pointerdown", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, activity, { passive: true, capture: true }));
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(idle);
      events.forEach((e) => window.removeEventListener(e, activity, { capture: true }));
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isSensitive, revealed]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const assignedTo = selected?.assigned_to ?? null;
  const prevHistKey = useRef("");
  useEffect(() => {
    if (!selectedId) return;
    const key = `${selectedId}:${assignedTo}`;
    const prev = prevHistKey.current;
    prevHistKey.current = key;
    // เพิ่งเปิดแชท: ได้มากับข้อมูลห้องแชทแล้ว · โหลดเองเฉพาะเมื่อผู้ดูแลของแชทเดิมเปลี่ยน
    if (!prev.startsWith(`${selectedId}:`) || prev === key) return;
    loadHistory(selectedId);
  }, [selectedId, assignedTo, loadHistory]);

  const cancelClosing = useCallback(() => setClosing(false), []);
  const flash = (s: string) => { setToast(s); setTimeout(() => setToast(""), 2500); };

  // ---------- actions ----------
  async function refreshSuggestions() {
    if (!selectedId) return;
    setSuggesting(true);
    const res = await fetch(`/api/conversations/${selectedId}/suggest`, { method: "POST" });
    setSuggesting(false);
    if (res.ok) { setSuggestion(await res.json()); setChosen(null); } else flash("สร้างคำแนะนำไม่สำเร็จ");
  }

  function pick(i: number) {
    const o = suggestion?.options[i];
    if (!o) return;
    setText(o.text);
    setChosen(i);
  }

  async function send() {
    if (!selectedId || !text.trim() || sending) return;
    setSending(true);
    const res = await fetch(`/api/conversations/${selectedId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, suggestionId: suggestion?.id ?? null, chosenIndex: chosen, skipTranslate: rawMode, cancelBookingId }),
    });
    setSending(false);
    if (!res.ok) {
      const msg = (await res.json().catch(() => ({}))).error ?? "ส่งไม่สำเร็จ";
      setSendError(msg);
      return flash(msg);
    }
    setSendError("");
    patchLocal(selectedId, { last_direction: "out", waiting_since: null, last_message_at: new Date().toISOString() });
    setText(""); setChosen(null); setSuggestion(null); setCancelBookingId(null);
    if (cancelBookingId) loadBookings(selectedId);
  }

  async function draftReschedule(id: string) {
    const res = await fetch(`/api/bookings/${id}/draft`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return flash(j.error ?? "สร้างข้อความไม่สำเร็จ");
    setText(j.text);
    setChosen(null);
    setCancelBookingId(id);
  }

  async function changeTag(tag: string, action: "add" | "remove") {
    if (!selectedId) return;
    const res = await fetch(`/api/conversations/${selectedId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag, action }),
    });
    if (!res.ok) return flash((await res.json().catch(() => ({}))).error ?? "บันทึกแท็กไม่สำเร็จ");
    const cur = convsRef.current.find((c) => c.id === selectedId) ?? openConv;
    if (cur) patchLocal(selectedId, { tags: action === "add" ? [...new Set([...cur.tags, tag])] : cur.tags.filter((t) => t !== tag) });
  }

  async function assign(to: string | null) {
    if (!selectedId) return;
    const res = await fetch(`/api/conversations/${selectedId}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    });
    if (!res.ok) return flash((await res.json().catch(() => ({}))).error ?? "เปลี่ยนผู้ดูแลไม่สำเร็จ");
    patchLocal(selectedId, { assigned_to: to });
  }

  useEffect(() => setEditingName(null), [selectedId]);

  async function saveContactName() {
    if (!selectedId || editingName == null) return;
    const res = await fetch(`/api/conversations/${selectedId}/contact`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: editingName }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return flash(j.error ?? "แก้ชื่อไม่สำเร็จ");
    setEditingName(null);
    flash("แก้ชื่อลูกค้าแล้ว");
    const cur = convsRef.current.find((c) => c.id === selectedId) ?? openConv;
    if (cur?.contacts) patchLocal(selectedId, { contacts: { ...cur.contacts, display_name: editingName.trim() || cur.contacts.display_name } });
  }

  async function splitImported() {
    if (!selectedId) return;
    setConfirmSplit(false);
    const res = await fetch(`/api/conversations/${selectedId}/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "split" }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return flash(j.error ?? "แยกประวัติไม่สำเร็จ");
    flash(`แยก ${j.moved} ข้อความไปแชทเก่าแล้ว`);
    forgetChatBundle(selectedId);
    setReloadTick((t) => t + 1);
    loadConvs();
  }

  async function acknowledgeSensitive() {
    const res = await fetch("/api/account/sensitive-ack", { method: "POST" });
    if (!res.ok) return flash("บันทึกไม่สำเร็จ");
    setAcked(true);
  }

  function reveal() {
    if (!selectedId) return;
    setRevealed(true);
    fetch(`/api/conversations/${selectedId}/sensitive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reveal: true }) }).catch(() => {});
  }

  async function setSensitive(on: boolean) {
    if (!selectedId) return;
    setConfirmUntag(false);
    const res = await fetch(`/api/conversations/${selectedId}/sensitive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sensitive: on }) });
    if (!res.ok) return flash((await res.json().catch(() => ({}))).error ?? "บันทึกไม่สำเร็จ");
    loadConvs();
  }

  async function createTag(name: string) {
    // แท็กใหม่จากห้องแชทเข้ากลุ่ม topic ไปก่อน ปรับสีและลำดับได้ในหน้าตั้งค่า
    const sort = Math.max(0, ...tags.filter((t) => t.group === "topic").map((t) => t.sort)) + 10;
    const { error } = await sb.from("tags").insert({ name, color: DEFAULT_TAG_COLOR, group: "topic", sort });
    if (error) return flash("สร้างแท็กไม่สำเร็จ");
    await loadTags();
    await changeTag(name, "add");
  }

  function toggleFilter(name: string) {
    setTagFilter((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]));
  }

  function attachFile(file: File | null | undefined) {
    if (!file) return;
    // ปุ่มแนบเดียวรับทั้งรูปและ PDF ชนิดจริงตรวจจาก magic bytes ที่ server ตรงนี้แค่กันเลือกผิด
    if (file.type === "application/pdf" || isPdfName(file.name)) {
      if (file.size > MAX_FILE_BYTES) return flash("PDF ต้องไม่เกิน 25MB");
      setAttachment({ file, kind: "file", previewUrl: "", name: file.name || "เอกสาร.pdf", size: file.size });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) return flash("รูปต้องไม่เกิน 10MB");
    setAttachment({ file, kind: "image", previewUrl: URL.createObjectURL(file), name: file.name || "รูปภาพ" });
  }

  function onPaste(e: React.ClipboardEvent) {
    const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    attachFile(item.getAsFile());
  }

  async function sendAttachment() {
    if (!selectedId || !attachment || sending) return;
    setSending(true);
    try {
      const uploadPath = attachment.file ? await uploadStaffImage(attachment.file) : undefined;
      const res = await fetch(`/api/conversations/${selectedId}/send-media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadPath, quickMediaId: attachment.quick?.id, caption, skipTranslate: rawMode,
          fileName: attachment.kind === "file" ? attachment.name : undefined,
        }),
      });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))).error ?? "ส่งไม่สำเร็จ";
        setSendError(msg);
        return flash(msg);
      }
      setSendError("");
      patchLocal(selectedId, { last_direction: "out", waiting_since: null, last_message_at: new Date().toISOString() });
      setAttachment(null); setCaption(""); setSuggestion(null); setChosen(null);
    } catch (e) {
      flash(e instanceof Error ? e.message : "ส่งไม่สำเร็จ");
    } finally {
      setSending(false);
    }
  }

  async function setConvMode(mode: AiMode | null) {
    if (!selectedId) return;
    const patch = { ai_mode: mode, ...(mode !== "fallback" ? { ai_due_at: null } : {}) };
    await sb.from("conversations").update(patch).eq("id", selectedId);
    patchLocal(selectedId, patch);
  }

  async function reopenCase() {
    if (!selected) return;
    await sb.from("conversations").update({ status: "open" }).eq("id", selected.id);
    patchLocal(selected.id, { status: "open" });
  }

  async function closeCase(tag?: string) {
    if (!selected) return;
    if (selected.booking_pending) return flash("ลงนัดก่อน");
    if (openTasks > 0) return flash(`เหลือ ${openTasks} งานที่ยังไม่เสร็จ`);
    const id = selected.id;
    setClosing(false);
    const res = await fetch(`/api/conversations/${id}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: tag && !selected.tags.includes(tag) ? tag : undefined }),
    });
    if (!res.ok) return flash((await res.json().catch(() => ({}))).error ?? "บันทึกไม่สำเร็จ");
    setSelectedId(nextOpenChat(sections.waiting, id));
    // เสร็จแล้ว: ลงช่วงล่าสุดทันที (realtime มาทีหลังไม่ต้องโหลดใหม่)
    patchLocal(id, { status: "closed" });
  }

  // ใช้ e.code เพราะ e.key เปลี่ยนตามแป้นพิมพ์ไทย/อังกฤษ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.code !== "KeyE") return;
      e.preventDefault();
      if (selected?.status !== "open") return;
      if (selected.booking_pending) return flash("ลงนัดก่อน");
      if ((selected.open_tasks ?? 0) > 0) return flash(`เหลือ ${selected.open_tasks} งานที่ยังไม่เสร็จ`);
      // กดครั้งแรกเปิดป๊อปอัป กดซ้ำ = ข้าม
      if (closing) closeCase();
      else setClosing(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function star(m: Message) {
    const res = await fetch(`/api/messages/${m.id}/star`, { method: "POST" });
    if (res.ok) {
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, starred: true } : x)));
      flash("บันทึกเป็นคำตอบมาตรฐานแล้ว ⭐");
    } else flash("บันทึกไม่สำเร็จ");
  }

  function onKey(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (attachment) sendAttachment(); else send(); }
    if (e.altKey && ["1", "2"].includes(e.key)) { e.preventDefault(); pick(Number(e.key) - 1); }
  }

  const effectiveMode = (c: Conversation): AiMode => c.ai_mode ?? c.channels?.ai_mode ?? globalMode;

  const allRows = convs;
  const sections = useMemo(() => queueSections(allRows, { filter: qfilter, meId: me.id }), [allRows, qfilter, me.id]);
  // แชทลับที่คนไม่มีสิทธิ์มองไม่เห็นชื่อ แต่ต้องรู้ว่ามีคนรอ (นับในช่วงรอตอบ)
  const showMasked = qfilter === "all" || qfilter === "waiting";
  useEffect(() => { setMtab("chat"); setApptSummary(null); setNoteCount(0); }, [selectedId]);
  useMobileTyping(!!selectedId);
  const openTasks = selected?.open_tasks ?? 0;
  // กดเสร็จแล้วไม่ได้เมื่อยังมีนัดรอลง หรืองานของทีมยังไม่ครบ server ตรวจซ้ำอีกชั้น
  const doneHint = selected?.booking_pending ? "ลงนัดก่อน" : openTasks > 0 ? `เหลือ ${openTasks} งานที่ยังไม่เสร็จ` : "";
  const doneBlocked = !!doneHint;
  const statusText = selected?.status === "closed" ? "เสร็จแล้ว" : selected && isWaitingForReply(selected) ? "รอตอบ" : "เปิดอยู่";
  const statusTags = tags.filter((t) => t.group === "status" && t.active && t.name !== SENSITIVE_TAG);
  const locked = !!selected?.sensitive && !acked;
  const blurred = !!selected?.sensitive && !revealed;
  // เจ้าหน้าที่ตอบแล้วถือว่ายืนยันว่าเป็นคนเดียวกัน ไม่ต้องมีปุ่มแยกอีก ข้อความ AI ไม่นับเป็นการยืนยัน
  const canSplitImported = messages.some((m) => m.imported)
    && !messages.some((m) => m.direction === "out" && m.sender_type === "staff" && !m.imported);

  const headHn = (apptSummary?.patient?.hn ?? selected?.contacts?.hn ?? null)?.toString().replace(/^0+(?=\d)/, "") ?? null;
  const headRights = headHn ? latestFacts(visitHistory)?.rights ?? null : null;
  const dueMin = selected?.ai_due_at ? Math.max(0, Math.ceil((new Date(selected.ai_due_at).getTime() - Date.now()) / 60000)) : null;
  // กติกา 24 ชม. ของ Facebook/Instagram
  const isMeta = selected?.channels?.type === "facebook" || selected?.channels?.type === "instagram";
  const lastInbound = [...messages].reverse().find((m) => m.direction === "in");
  const inboundAgeH = lastInbound ? (Date.now() - new Date(lastInbound.created_at).getTime()) / 3_600_000 : null;
  const metaWindow = !isMeta || inboundAgeH == null ? null
    : inboundAgeH <= 24 ? null
    : inboundAgeH <= 24 * 7 ? "human" : "closed";
  // LINE: ส่งครั้งนี้จะเป็น reply (ฟรี) หรือ push (นับโควตา)
  const suggestedTags = (suggestion?.suggested_tags ?? []).filter((t) => !selected?.tags.includes(t));
  const edited = chosen != null && suggestion?.options[chosen] && suggestion.options[chosen].text !== text;

  return (
    <div className={`inbox ${selected ? "has-chat" : ""}`} data-mtab={mtab}>
      {/* ---------- รายการแชท ---------- */}
      <aside className="conv-list">
        <div className="m-inbox-head" aria-hidden="true">Doc<span>Desk</span></div>
        <div className="inbox-search">
          <label className="search-box">
            <Icon name="search" size={16} />
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหาชื่อ ข้อความ หรือแท็ก…" aria-label="ค้นหาแชท" />
          </label>
        </div>
        {/* ขอบเขตแชท 3 ช่อง อยู่ที่เดิมเสมอ · ช่วง รอตอบ / งานค้าง / ล่าสุด ดูจากหัวข้อในรายการ (ไม่ซ้ำกัน) */}
        <div className="q-filters" role="group" aria-label="ขอบเขตแชท">
          {([
            ["all", "ทั้งหมด", 0],
            ["mine", "ของฉัน", qcounts.mine],
            ["unassigned", "ยังไม่มีคนรับ", qcounts.unassigned],
          ] as [InboxFilter, string, number][]).map(([key, label, n]) => (
            <button key={key} type="button" aria-pressed={qfilter === key} className={`q-filter ${key} ${qfilter === key ? "on" : ""}`} onClick={() => setQfilter(key)}>
              {label}{n > 0 && <b className="badge red">{n}</b>}
            </button>
          ))}
        </div>
        <details className="tag-filter">
          <summary>กรองตามแท็ก{tagFilter.length > 0 && <b className="badge">{tagFilter.length}</b>}</summary>
          <div className="tag-filter-list">
            {tags.filter((t) => t.active).map((t) => (
              <button key={t.id} className={`tag-toggle ${tagFilter.includes(t.name) ? "on" : ""}`}
                aria-pressed={tagFilter.includes(t.name)} onClick={() => toggleFilter(t.name)}>
                <TagChip name={t.name} color={t.color} />
              </button>
            ))}
            <button className="btn ghost small" disabled={!tagFilter.length} onClick={() => setTagFilter([])}>ล้างตัวกรอง</button>
          </div>
          {tagFilter.length > 1 && <div className="muted small">แสดงแชทที่มีครบทุกแท็กที่เลือก</div>}
        </details>

        {(["waiting", "work", "recent"] as const).map((sec) => {
          const rows = sections[sec];
          const masked = sec === "waiting" && showMasked ? maskedWaiting : [];
          if (qfilter === "waiting" && sec !== "waiting") return null;
          if (qfilter === "work" && sec !== "work") return null;
          const title = sec === "waiting" ? "รอตอบ" : sec === "work" ? "งานค้าง" : "ล่าสุด";
          // ตัวเลขทั้งหมดใน server (โหลดมาทีละหน้า) · ล่าสุด = ที่โหลดแล้ว + "+" ถ้ายังมีอีก
          const n = (qfilter === "all" || qfilter === "waiting" || qfilter === "work") && sec !== "recent" ? Math.max(qcounts[sec], rows.length) + masked.length : rows.length + masked.length;
          const more = sec === "recent" && !!nextCursor ? "+" : "";
          return (
            <section key={sec} className={`q-section ${sec}`} aria-label={title}>
              <h3 className="q-head">{title} <span className="q-count">{n}{more}</span></h3>
              {masked.map((m) => (
                <div key={m.key} className="conv q-row masked" aria-label="แชทลับรอตอบ">
                  <span className="conv-avatar"><div className="avatar"><Icon name="lock" /></div></span>
                  <div className="q-main">
                    <div className="q-line1"><span className="name">แชทลับ</span></div>
                    <div className="q-line2"><WaitChip since={m.waiting_since} /><span className="muted small">รอเจ้าหน้าที่ที่มีสิทธิ์ตอบ</span></div>
                  </div>
                </div>
              ))}
              {n === 0 && (
                <div className="q-empty">{sec === "waiting" ? "🎉 ตอบครบแล้ว" : sec === "work" ? "ไม่มีงานค้าง" : search.trim() || tagFilter.length ? "ไม่พบแชทที่ตรงกับการค้นหา" : "ยังไม่มีแชท"}</div>
              )}
              {rows.map((c) => {
                const top = sec === "work" && c.work_label ? { kind: c.work_kind ?? "", label: c.work_label } : null;
                const hn = c.contacts?.hn ? String(c.contacts.hn).replace(/^0+/, "") : null;
                return (
                  <button key={c.id} type="button" className={`conv q-row ${c.id === selectedId ? "active" : ""} ${c.status === "closed" ? "closed" : ""}`}
                    onClick={() => setSelectedId(c.id)}>
                    {/* รูปโปรไฟล์เดิม + จุดสีช่องทางมุมขวาล่าง */}
                    <span className="conv-avatar" title={c.channels ? CHANNEL_LABEL[c.channels.type] : ""}>
                      {c.sensitive ? <div className="avatar"><Icon name="lock" /></div> : <Avatar name={c.contacts?.display_name} url={c.contacts?.avatar_url} />}
                      <span className={`ch-dot q-ch ch-${c.channels?.type ?? "other"}`} aria-hidden="true" />
                    </span>
                    <div className="q-main">
                      {/* บรรทัด 1: ชื่อ · HN ··· เวลา */}
                      <div className="q-line1">
                        <span className={`name ${c.sensitive ? "sensitive-text" : ""}`}>{contactName(c.contacts)}</span>
                        {hn && !c.sensitive && <span className="q-hn">· HN {hn}</span>}
                        <span className="q-time">{timeTh(c.last_message_at)}</span>
                      </div>
                      {/* บรรทัด 2: สิ่งที่ต้องทำ + แท็กของแชท (เกินตัดทิ้ง ไม่ขึ้นบรรทัดใหม่) */}
                      <div className="q-line2">
                        {sec === "waiting" && <WaitChip since={c.waiting_since ?? c.last_inbound_at} />}
                        {top && <span className={`chip q-work ${top.kind}`}>{top.label}</span>}
                        {sec === "recent" && c.status === "closed" && <span className="chip done-chip">เสร็จ</span>}
                        {c.tags.map((t) => <TagChip key={t} name={t} color={tagColor.get(t)} />)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </section>
          );
        })}
        {/* เลื่อนถึงตรงนี้ = โหลดหน้าถัดไป */}
        {nextCursor && <div ref={moreRef} className="q-more muted small">กำลังโหลด…</div>}
      </aside>

      {/* ---------- ห้องแชท + กล่องทีม ---------- */}
      <div className="chat-area">
      <section
        className={`chat ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => { if (selected) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!selected) return;
          e.preventDefault();
          setDragging(false);
          attachFile(e.dataTransfer.files[0]);
        }}
      >
        {!selected ? (
          <div className="empty big">เลือกแชททางซ้ายเพื่อเริ่มตอบ</div>
        ) : (
          <>
            <header className="chat-head compact">
              <button className="icon-btn chat-back" aria-label="กลับไปรายการแชท" title="กลับไปรายการแชท" onClick={() => setSelectedId(null)}><Icon name="chevronLeft" /></button>
              {selected.sensitive ? <div className="avatar small"><Icon name="lock" size={14} /></div> : <Avatar name={selected.contacts?.display_name} url={selected.contacts?.avatar_url} small />}
              <div className="chat-head-main">
                {editingName != null ? (
                  <form className="name-edit" onSubmit={(e) => { e.preventDefault(); saveContactName(); }}>
                    <input autoFocus value={editingName} maxLength={80} aria-label="ชื่อลูกค้า"
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Escape") setEditingName(null); }} />
                    <button className="btn small" type="submit">บันทึก</button>
                    <button className="btn ghost small" type="button" onClick={() => setEditingName(null)}>ยกเลิก</button>
                  </form>
                ) : (
                  <div className="head-line">
                    <span className={`name ${blurred ? "sensitive-text" : ""}`}>{contactName(selected.contacts)}{headHn && !blurred && <span className="head-hn"> · HN {headHn}</span>}</span>
                    {!blurred && (staffMayRename(selected.contacts) ? (
                      <button className="icon-btn ghost tiny" type="button" title="แก้ชื่อลูกค้า" aria-label="แก้ชื่อลูกค้า"
                        onClick={() => setEditingName(selected.contacts?.display_name ?? "")}><Icon name="pencil" size={14} /></button>
                    ) : (
                      <span className="icon-btn ghost tiny static" role="img" aria-label="ชื่อจาก HIS (ล็อก)"
                        title="ชื่อจาก HIS แก้ไม่ได้ ต้องยกเลิกการผูก HN ก่อน"><Icon name="lock" size={14} /></span>
                    ))}
                    {/* มือถือ (ตามแบบ): ช่องทาง · สิทธิ + แท็ก */}
                    <span className="head-sub-m">
                      <span className="head-ch">{selected.channels ? CHANNEL_LABEL[selected.channels.type] : ""}{headRights ? ` · ${headRights}` : ""}</span>
                      {!blurred && selected.tags.filter((t) => t !== SENSITIVE_TAG).map((t) => <TagChip key={t} name={t} color={tagColor.get(t)} />)}
                    </span>
                    <span className="head-sub">
                      {!blurred && contactLabel(selected.contacts).secondary && <span className="name-platform">{contactLabel(selected.contacts).secondary} · </span>}
                      {selected.channels?.name}
                      {customerLang !== "th" && <> · ภาษา{LANGUAGE_NAME[customerLang] ?? customerLang} (ระบบแปลให้)</>}
                    </span>
                  </div>
                )}
              </div>
              {selected.archived ? (
                <span className="chip">LINE OA เดิม</span>
              ) : (
                <>
                  <AssigneeControl me={me} assignedTo={selected.assigned_to} onChange={assign}
                    staff={selected.sensitive ? staffList.filter((s) => s.role === "admin" || s.can_view_sensitive) : staffList} />
                  {selected.status === "open" && (
                    <div className="close-anchor">
                      <button className="btn done head-done" title={doneHint || "Ctrl+Shift+E"} disabled={doneBlocked}
                        aria-describedby={doneBlocked ? "done-hint" : undefined} aria-expanded={closing}
                        onClick={() => setClosing(!closing)}><Icon name="check" /> เสร็จแล้ว</button>
                      {closing && (
                        <CloseCasePopup tags={statusTags} current={selected.tags} hasDraft={!!text.trim() || !!attachment || !!caption.trim()}
                          onChoose={closeCase} onCancel={cancelClosing} />
                      )}
                    </div>
                  )}
                </>
              )}
            </header>

            {!selected.archived && (
              <MobileChatTabs tab={mtab} onTab={setMtab} appointments={apptSummary?.count ?? 0} tasks={openTasks} notes={noteCount} />
            )}
            {!selected.archived && (
              <div className="m-assignee-row">
                <AssigneeControl me={me} assignedTo={selected.assigned_to} onChange={assign} showClaim
                  staff={selected.sensitive ? staffList.filter((s) => s.role === "admin" || s.can_view_sensitive) : staffList} />
              </div>
            )}
            {!selected.archived && openTasks > 0 && mtab === "chat" && (
              <button type="button" className="m-task-banner" onClick={() => setMtab("info")}>
                <Icon name="check" size={16} /><span className="one">งานค้าง {openTasks}{firstTask ? `: ${firstTask}` : ""}</span>
              </button>
            )}

            <details className="customer-panel">
              <summary>ประวัติผู้ดูแล</summary>
              <div className="small">ช่องทาง: {selected.channels?.name}</div>
              {history.length === 0 && <div className="muted small">ยังไม่มีการเปลี่ยนผู้ดูแล</div>}
              {history.map((h) => (
                <div key={h.id} className="muted small">
                  {timeTh(h.created_at)}: {staffName.get(h.from_staff ?? "") ?? "ไม่มี"} → {staffName.get(h.to_staff ?? "") ?? "ไม่มี"}
                  {h.by_staff && <> (โดย {staffName.get(h.by_staff) ?? "เจ้าหน้าที่"})</>}
                </div>
              ))}
            </details>

            {!selected.archived && !locked && (
              <ArchiveMergeBar conversationId={selected.id} onError={flash}
                onDone={() => { flash("รวมประวัติแล้ว"); forgetChatBundle(selected.id); setReloadTick((t) => t + 1); loadConvs(); }} />
            )}
            {selected.sensitive && (
              <div className="sensitive-banner" role="alert">🔒 ข้อมูลลับผู้ป่วย — ห้ามพูดชื่อหรืออาการต่อหน้าผู้อื่น ห้ามถ่ายหน้าจอ ห้ามส่งต่อ</div>
            )}
            {locked && (
              <div className="sensitive-ack card">
                <label className="raw">
                  <input type="checkbox" checked={ackChecked} onChange={(e) => setAckChecked(e.target.checked)} />
                  รับทราบว่าข้อมูลนี้เป็นความลับผู้ป่วย จะไม่พูดชื่อหรืออาการต่อหน้าผู้อื่น ไม่ถ่ายหน้าจอ และไม่ส่งต่อ
                </label>
                <button className="btn primary small" disabled={!ackChecked} onClick={acknowledgeSensitive}>รับทราบ</button>
              </div>
            )}
            {selected.sensitive && !locked && (
              <div className="sensitive-reveal">
                {revealed
                  ? <button className="btn ghost small" onClick={() => setRevealed(false)}>ซ่อนข้อความ</button>
                  : <button className="btn primary small" onClick={reveal}>แสดง</button>}
                <span className="muted small">เบลอกลับเมื่อไม่ขยับ 60 วินาที หรือสลับหน้าต่าง</span>
              </div>
            )}

            {dueMin != null && (
              <div className="banner">⏱ ถ้าไม่มีใครตอบ AI จะตอบแทนในอีก ~{dueMin} นาที</div>
            )}

            {metaWindow === "human" && (
              <div className="banner">⏳ ลูกค้าทักมาเกิน 24 ชม. แล้ว — เจ้าหน้าที่ยังตอบได้ถึง 7 วัน (AI ตอบแทนไม่ได้)</div>
            )}
            {metaWindow === "closed" && (
              <div className="banner red">⛔ เกิน 7 วันหลังลูกค้าทักล่าสุด {selected.channels?.type === "facebook" ? "Facebook" : "Instagram"} ไม่อนุญาตให้ส่ง ต้องรอลูกค้าทักมาก่อน</div>
            )}

            <div className={`messages ${blurred ? "sensitive-blur" : ""}`} ref={listRef}>
              <div className="status-strip" role="status">
                <span className={`status-chip ${selected.status === "closed" ? "done" : statusText === "รอตอบ" ? "wait" : ""}`}>{statusText}</span>
                {doneHint && selected.status === "open" && <span id="done-hint" className="status-hint">{doneHint}</span>}
              </div>
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.direction} ${m.sender_type} ${m.imported ? "imported" : ""}`}>
                  <div className="bubble">
                    {m.media_type === "file" ? <ChatFile message={m} /> : m.media_type && <ChatImage message={m} />}
                    {(m.body_th ?? m.body) && <div>{m.body_th ?? m.body}</div>}
                    {m.body_th && (
                      <div className="orig">
                        {m.direction === "in" ? "ต้นฉบับ: " : "ส่งจริง: "}{m.body}
                      </div>
                    )}
                  </div>
                  <div className="meta">
                    {m.imported ? <span className="imported-tag">นำเข้าจาก LINE · {timeTh(m.created_at)}</span> : <span>{senderLabel(m, staffName)}{timeTh(m.created_at)}</span>}
                    {m.direction === "out" && !m.imported && <span>{m.read_by_customer_at ? "✓✓ อ่านแล้ว" : "✓ ส่งแล้ว"}</span>}
                    {m.direction === "out" && !m.media_type && !m.imported && (
                      <button className={`star ${m.starred ? "on" : ""}`} title="บันทึกเป็นคำตอบมาตรฐาน"
                        onClick={() => !m.starred && star(m)}>{m.starred ? "★" : "☆"}</button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {selected.archived ? (
              <div className="archived-notice" role="status">แชทนำเข้าจาก LINE OA ส่งข้อความไม่ได้ รอลูกค้าทักมาใหม่</div>
            ) : (
            <>
            {/* ---------- คำแนะนำ ---------- */}
            <div className={`suggest ${suggestOpen ? "" : "closed"} ${blurred ? "sensitive-blur" : ""}`}>
              {/* หัวข้อบรรทัดเดียว: [พับ] คำตอบแนะนำ · แท็กที่ AI แนะนำ · ส่งตามที่พิมพ์ · แนะนำใหม่ */}
              <div className="suggest-head">
                <button type="button" className="suggest-toggle" aria-expanded={suggestOpen} onClick={toggleSuggest}
                  aria-label={suggestOpen ? "พับคำตอบแนะนำ" : "เปิดคำตอบแนะนำ"} title={suggestOpen ? "พับ" : "เปิด"}>
                  <Icon name="chevronLeft" size={16} />
                </button>
                <span className="suggest-title"><Icon name="sparkle" /> คำตอบแนะนำ <span className="muted small">(Alt+1/2)</span></span>
                {/* เตือนเรื่องอาการ/ยา: แสดงแม้พับ (ความปลอดภัย) */}
                {suggestion?.needs_human && <span className="chip red needs-human" title="เรื่องอาการ/ยา/ร้องเรียน — โปรดตรวจก่อนส่ง"><Icon name="alert" size={14} /> <span className="hide-sm">โปรด</span>ตรวจก่อนส่ง</span>}
                {suggestOpen && suggestedTags.length > 0 && (
                  <span className="ai-tags" aria-label="แท็กที่ AI แนะนำ">
                    {suggestedTags.map((t) => (
                      <button key={t} className="ai-tag" aria-label={`ติดแท็ก ${t}`} onClick={() => changeTag(t, "add")}>{t} ✓</button>
                    ))}
                  </span>
                )}
                {customerLang !== "th" && (
                  <label className="raw">
                    <input type="checkbox" checked={rawMode} onChange={(e) => setRawMode(e.target.checked)} />
                    <span className="hide-sm">ส่งตามที่พิมพ์ </span>(ไม่แปล)
                  </label>
                )}
                {suggestOpen && (
                  <button className="btn ghost small suggest-refresh" onClick={refreshSuggestions} disabled={suggesting} aria-label="แนะนำใหม่" title="แนะนำใหม่">
                    {suggesting ? "กำลังคิด…" : <>↻<span className="hide-sm"> แนะนำใหม่</span></>}
                  </button>
                )}
              </div>
              {suggestOpen && <div className="sugg-list">
                {!suggestion && !suggesting && <div className="muted small">ยังไม่มีคำแนะนำ กด “แนะนำใหม่”</div>}
                {suggestion?.options.map((o, i) => (
                  <button key={i} className={`sugg ${chosen === i ? "on" : ""}`} onClick={() => pick(i)}>
                    <div className="sugg-meta">
                      <span>{i + 1}. {SOURCE_LABEL[o.source]}</span>
                      <span className={`conf ${o.confidence >= 0.75 ? "hi" : o.confidence >= 0.5 ? "mid" : "lo"}`}>
                        มั่นใจ {Math.round(o.confidence * 100)}%
                      </span>
                    </div>
                    <div>{o.text}</div>
                    {o.note && <div className="note">ℹ️ {o.note}</div>}
                  </button>
                ))}
              </div>}
            </div>

            {/* ---------- ช่องพิมพ์ ---------- */}
            <div className="composer">
              {quickMedia.length > 0 && (
                <div className="quick-bar" aria-label="รูปที่ใช้บ่อย">
                  {quickMedia.map((q) => (
                    <button key={q.id} className="quick-item" title={q.title}
                      onClick={() => setAttachment({ quick: q, previewUrl: q.previewUrl ?? "", name: q.title })}>
                      {q.previewUrl && <img src={q.previewUrl} alt={q.title} />}
                      <span className="small">{q.title}</span>
                    </button>
                  ))}
                </div>
              )}
              {attachment && (
                <div className="attach-preview">
                  {attachment.kind === "file" ? (
                    <div className="file-chip" title={attachment.name}><Icon name="file" /> {attachment.name}{attachment.size ? ` · ${formatFileSize(attachment.size)}` : ""}</div>
                  ) : (
                    <img src={attachment.previewUrl} alt={attachment.name} />
                  )}
                  <input value={caption} onChange={(e) => setCaption(e.target.value)} onKeyDown={onKey}
                    placeholder={attachment.kind === "file" ? "ข้อความประกอบไฟล์ (ไม่ใส่ก็ได้)" : "คำบรรยายรูป (ไม่ใส่ก็ได้)"}
                    aria-label={attachment.kind === "file" ? "ข้อความประกอบไฟล์" : "คำบรรยายรูป"} />
                  <button className="btn ghost small" onClick={() => { setAttachment(null); setCaption(""); }}>ยกเลิก</button>
                </div>
              )}
              {/* แถวเดียว: แนบ (ซ้าย) · ช่องพิมพ์ · ส่ง (ขวา) แบบ LINE / WhatsApp */}
              <div className="composer-input">
              <button type="button" className="c-attach" title="แนบรูปหรือ PDF (ลากวาง หรือ Ctrl+V ได้)" aria-label="แนบรูปหรือ PDF"
                onClick={() => fileInput.current?.click()}><Icon name="paperclip" size={20} /></button>
              <input ref={fileInput} type="file" accept="image/*,.heic,.heif,application/pdf,.pdf" hidden
                onChange={(e) => { attachFile(e.target.files?.[0]); e.target.value = ""; }} />
              <textarea
                value={text}
                onChange={(e) => { setText(e.target.value); if (!e.target.value.trim()) setCancelBookingId(null); }}
                onKeyDown={onKey}
                onPaste={onPaste}
                placeholder={customerLang !== "th" && !rawMode ? "พิมพ์ภาษาไทย ระบบจะแปลให้ลูกค้า… (Ctrl+Enter ส่ง)" : "พิมพ์ข้อความ… (Ctrl+Enter ส่ง)"}
              />
              {/* มือถือ: ปุ่มส่งเป็นไอคอน · จอใหญ่: ปุ่มส่งมีข้อความ (foot-send) */}
              <button type="button" className="m-send" aria-label={customerLang !== "th" && !rawMode ? "แปลและส่ง" : "ส่ง"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={attachment ? sendAttachment : send}
                disabled={sending || metaWindow === "closed" || (!attachment && !text.trim())}>
                <Icon name="send" size={20} />
              </button>
              {attachment ? (
                <button className="btn primary foot-send" onClick={sendAttachment} disabled={sending || metaWindow === "closed"}>
                  {sending ? "กำลังส่ง…" : attachment.kind === "file" ? "ส่งไฟล์" : "ส่งรูป"}
                </button>
              ) : (
                <button className="btn primary foot-send" onClick={send} disabled={sending || !text.trim() || metaWindow === "closed"}>
                  {sending ? "กำลังส่ง…" : customerLang !== "th" && !rawMode ? `แปล & ส่ง` : "ส่ง"}
                </button>
              )}
              </div>
              {sendError && (
                <div className="send-error" role="alert">⛔ {sendError} — ข้อความยังอยู่ในช่องพิมพ์ ยังไม่ถึงลูกค้า{/โควตา LINE/.test(sendError) ? " (ตอบได้อีกครั้งเมื่อลูกค้าทักมาใหม่ หรือโทรหาลูกค้า)" : ""}</div>
              )}
              <div className="composer-foot">
                <div className="muted small">
                  {cancelBookingId && "📅 ส่งข้อความนี้แล้วนัดจะถูกยกเลิก "}
                  {chosen != null && (edited ? "✏️ แก้จากคำแนะนำ — ระบบจะจำสำนวนนี้" : "✅ ใช้คำแนะนำตามเดิม")}
                </div>
              </div>
            </div>
            </>
            )}
          </>
        )}
      </section>
      {selected && !locked && (
        <aside className="team-panel" aria-label="ข้อมูลลูกค้า">
          <section className="side-block tp-info">
            <div className="cust-header">
              <h2 className="cust-title">ข้อมูลลูกค้า</h2>
              {isAdmin && !selected.archived && (
                <button type="button" className="icon-btn cust-link" aria-label="แก้ไขการเชื่อมคนไข้" title="เปลี่ยนคนไข้ที่เชื่อม (ผูก HN)"
                  onClick={() => window.dispatchEvent(new CustomEvent("docdesk:link-hn"))}><Icon name="link" /></button>
              )}
            </div>
            <CustomerCard conversation={selected} patient={apptSummary?.patient ?? null} facts={latestFacts(visitHistory)} blurred={blurred}
              onNewAppointment={selected.archived ? undefined : () => window.dispatchEvent(new CustomEvent("docdesk:new-appt"))}
              tags={<>
                {selected.tags.map((t) => (
                  <TagChip key={t} name={t} color={tagColor.get(t)} ai={tagSources[t] === "ai"}
                    onRemove={t === SENSITIVE_TAG ? undefined : () => changeTag(t, "remove")} />
                ))}
                <TagPicker tags={tags} current={selected.tags} onPick={(t) => changeTag(t, "add")} onCreate={isAdmin ? createTag : undefined} />
              </>}
              lockSwitch={selected.archived ? undefined : (
                <button type="button" role="switch" aria-checked={!!selected.sensitive} className={`lock-switch ${confirmUntag ? "confirm" : ""}`}
                  disabled={!!selected.sensitive && !isAdmin}
                  title={selected.sensitive ? (isAdmin ? (confirmUntag ? "กดอีกครั้งเพื่อยืนยันเอาออกจากแชทลับ" : "เอาออกจากแชทลับ") : "แชทลับ (admin เท่านั้นที่เอาออกได้)") : "แชทลับ: เห็นเฉพาะผู้มีสิทธิ์ และ AI ไม่อ่านแชทนี้"}
                  onClick={() => (!selected.sensitive ? setSensitive(true) : confirmUntag ? setSensitive(false) : setConfirmUntag(true))}>
                  <Icon name="lock" size={14} />{confirmUntag ? "ยืนยัน?" : "แชทลับ"}<span className="m-switch" aria-hidden="true" />
                </button>
              )} />
            {!selected.archived && (
              <div className="side-row">
                <select aria-label="AI แชทนี้" title={AI_MODE_HINT[effectiveMode(selected)]} value={selected.ai_mode ?? ""} disabled={!isAdmin}
                  onChange={(e) => setConvMode((e.target.value || null) as AiMode | null)}>
                  <option value="">AI: ตามช่องทาง ({AI_MODE_LABEL[selected.channels?.ai_mode ?? globalMode]})</option>
                  {(Object.keys(AI_MODE_LABEL) as AiMode[]).map((m) => <option key={m} value={m}>AI: {AI_MODE_LABEL[m]}</option>)}
                </select>
                {!selected.sensitive ? (
                  <button type="button" className="icon-btn side-lock" aria-label="ตั้งเป็นแชทลับ" title="ตั้งเป็นแชทลับ" onClick={() => setSensitive(true)}><Icon name="lock" /></button>
                ) : isAdmin ? (
                  <button type="button" className={`icon-btn on side-lock ${confirmUntag ? "confirm" : ""}`} aria-label={confirmUntag ? "ยืนยันเอาออกจากแชทลับ" : "เอาออกจากแชทลับ"}
                    title={confirmUntag ? "กดอีกครั้งเพื่อยืนยันเอาออกจากแชทลับ" : "เอาออกจากแชทลับ"}
                    onClick={() => (confirmUntag ? setSensitive(false) : setConfirmUntag(true))}><Icon name="unlock" /></button>
                ) : (
                  <span className="icon-btn on static side-lock" role="img" aria-label="แชทลับ" title="แชทลับ (admin เท่านั้นที่เอาออกได้)"><Icon name="lock" /></span>
                )}
                {selected.status === "closed" && (
                  <button type="button" className="icon-btn" aria-label="เปิดแชทนี้ใหม่" title="เปิดแชทนี้ใหม่" onClick={reopenCase}><Icon name="reopen" /></button>
                )}
                {canSplitImported && (
                  <button type="button" className={`icon-btn ${confirmSplit ? "confirm" : ""}`}
                    aria-label={confirmSplit ? "ยืนยันแยกประวัติที่นำเข้า" : "แยกประวัติที่นำเข้า"} title={confirmSplit ? "กดอีกครั้งเพื่อยืนยันแยกประวัติ" : "แยกประวัติที่นำเข้า"}
                    onClick={() => (confirmSplit ? splitImported() : setConfirmSplit(true))}><Icon name="split" /></button>
                )}
              </div>
            )}
          </section>
          {!selected.archived && (
            <>
              <BookingsBlock conversationId={selected.id} contactName={selected.contacts?.display_name ?? null} bookings={bookings} blurred={blurred}
                onError={flash} onReschedule={draftReschedule} onChanged={() => { loadBookings(selected.id); scheduleWork(); }} />
              <WebBookingCard messages={messages} conversationId={selected.id} bookedDates={apptSummary?.dates ?? []} latestApptAt={apptSummary?.latestCreatedAt ?? null} blurred={blurred}
                onError={flash} onSaved={() => { loadBookings(selected.id); scheduleWork(); }} />
              <AppointmentsBlock onSummary={setApptSummary} conversationId={selected.id} contactName={selected.contacts?.patient_full_name || selected.contacts?.display_name || null} blurred={blurred} isAdmin={isAdmin}
                onMessage={flash} onChanged={() => { loadBookings(selected.id); scheduleWork(); }}
                footer={<LabResultsBlock conversationId={selected.id} blurred={blurred} />} />
              <TeamPanel onNoteCount={setNoteCount} onFirstTask={setFirstTask} conversationId={selected.id} sensitive={!!selected.sensitive} closed={selected.status === "closed"}
                staff={staffList} onChanged={scheduleWork} onError={flash}>
                <VisitHistoryBlock history={visitHistory} blurred={blurred} />
              </TeamPanel>
            </>
          )}
        </aside>
      )}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/** แสดง preview ก่อน คลิกเปิดรูปใหญ่ รูปอยู่ใน bucket private เปิดผ่าน signed URL อายุ 10 นาทีเท่านั้น */
function ChatImage({ message: m }: { message: Message }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!m.media_preview_path) return;
    sb.storage.from("chat-media").createSignedUrl(m.media_preview_path, SIGNED_URL_SECONDS)
      .then(({ data }) => setPreviewUrl(data?.signedUrl ?? null));
  }, [sb, m.media_preview_path]);

  async function openFull() {
    if (!m.media_path) return;
    // เปิดหน้าต่างก่อน ไม่อย่างนั้นเบราว์เซอร์จะบล็อกเพราะมีการรอ
    const win = window.open("", "_blank");
    const { data } = await sb.storage.from("chat-media").createSignedUrl(m.media_path, SIGNED_URL_SECONDS);
    if (win && data?.signedUrl) win.location.href = data.signedUrl;
    else win?.close();
  }

  if (m.media_deleted_at) return <div className="media-note">รูปถูกลบตามนโยบายเก็บข้อมูล</div>;
  if (!m.media_path) {
    const stuck = Date.now() - new Date(m.created_at).getTime() > IMAGE_LOADING_MAX_MS;
    return <div className="media-note">{stuck ? "[รูปภาพ — โหลดไม่สำเร็จ เปิดดูในแอปต้นทาง]" : "กำลังโหลดรูป…"}</div>;
  }
  return (
    <button className="chat-image" onClick={openFull} title="เปิดรูปใหญ่" aria-label="เปิดรูปใหญ่">
      {previewUrl ? <img src={previewUrl} alt="รูปภาพในแชท" /> : <span className="media-note">กำลังโหลดรูป…</span>}
    </button>
  );
}

/** ไฟล์ในแชท: การ์ดชื่อไฟล์ทุกช่องทาง คลิกเปิดผ่าน signed URL อายุ 10 นาทีเหมือนรูป */
function ChatFile({ message: m }: { message: Message }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const name = m.file_name || "เอกสาร.pdf";

  async function open() {
    if (!m.media_path) return;
    // เปิดหน้าต่างก่อน ไม่อย่างนั้นเบราว์เซอร์จะบล็อกเพราะมีการรอ
    const win = window.open("", "_blank");
    const { data } = await sb.storage.from("chat-media").createSignedUrl(m.media_path, SIGNED_URL_SECONDS);
    if (win && data?.signedUrl) win.location.href = data.signedUrl;
    else win?.close();
  }

  if (m.media_deleted_at) return <div className="media-note">ไฟล์ถูกลบตามนโยบายเก็บข้อมูล</div>;
  if (!m.media_path) {
    const stuck = Date.now() - new Date(m.created_at).getTime() > IMAGE_LOADING_MAX_MS;
    return <div className="media-note">{stuck ? "[ไฟล์ — โหลดไม่สำเร็จ เปิดดูในแอปต้นทาง]" : `กำลังโหลดไฟล์ ${name}…`}</div>;
  }
  return (
    <button className="chat-file" onClick={open} title="เปิดไฟล์" aria-label={`เปิดไฟล์ ${name}`}>
      <span className="chat-file-icon" aria-hidden="true"><Icon name="file" size={20} /></span>
      <span className="chat-file-text">
        <span className="chat-file-name">{name}</span>
        <span className="chat-file-size">{formatFileSize(m.file_size) || "PDF"}</span>
      </span>
    </button>
  );
}

/** ผู้ส่งข้อความขาออก เช่น "Admin · " หรือ "🤖 AI · " ข้อความลูกค้าไม่ต้องแสดง */
function senderLabel(m: Message, names: Map<string, string>): string {
  if (m.direction !== "out") return "";
  if (m.sender_type === "ai") return "🤖 AI · ";
  if (m.imported_sender_name) return `${m.sender_type === "system" ? "⚙️ " : ""}${m.imported_sender_name} · `;
  return `${(m.sender_id && names.get(m.sender_id)) || "เจ้าหน้าที่"} · `;
}

function WaitChip({ since }: { since: string | null }) {
  const badge = waitBadge(since);
  return badge ? <span className={`chip wait-${badge.level}`}>{badge.text}</span> : null;
}

function Avatar({ name, url, small }:{ name?: string | null; url?: string | null; small?: boolean }) {
  const cls = small ? "avatar small" : "avatar";
  if (url) return <img className={cls} src={url} alt="" />;
  return <div className={cls}>{(name || "?").slice(0, 1)}</div>;
}
