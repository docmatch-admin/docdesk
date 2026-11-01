"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { LANGUAGE_NAME } from "@/lib/translate-names";
import { staffInitial } from "@/lib/assignment";
import { CLOSE_PATCH, isWaitingForReply, nextOpenChat, waitBadge } from "@/lib/case-flow";
import { DEFAULT_TAG_COLOR, type Tag } from "@/lib/tags";
import { MAX_UPLOAD_BYTES, uploadStaffImage } from "@/lib/upload-client";
import { TagChip } from "../tag-chip";
import { AssigneeControl } from "./assignee-control";
import { CloseCasePopup } from "./close-case-popup";
import { TagPicker } from "./tag-picker";
import {
  AI_MODE_HINT, AI_MODE_LABEL, CHANNEL_LABEL,
  type AiMode, type Conversation, type Message, type SuggestionOption, type SuggestionResult,
} from "@/lib/types";

type Filter = "waiting" | "open" | "closed";

const SOURCE_LABEL: Record<SuggestionOption["source"], string> = {
  knowledge: "📚 ฐานข้อมูล",
  example: "💬 คำตอบเดิม",
  history: "🕘 ประวัติลูกค้า",
};

const timeTh = (iso: string) =>
  new Date(iso).toLocaleString("th-TH", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", timeZone: "Asia/Bangkok" });

interface StaffOption { id: string; display_name: string; active: boolean }
interface AssignmentEntry { id: number; from_staff: string | null; to_staff: string | null; by_staff: string | null; created_at: string }
interface QuickMedia { id: string; title: string; preview_path: string; previewUrl?: string }
interface Attachment { file?: File; quick?: QuickMedia; previewUrl: string; name: string }

const SCOPE_KEY = "docdesk_inbox_scope";
const SIGNED_URL_SECONDS = 600;
/** รูปเข้าที่ยังโหลดไม่เสร็จนานเกินนี้ถือว่าล้มเหลว (เช่น function ถูกตัดก่อนโหลดเสร็จ) */
const IMAGE_LOADING_MAX_MS = 2 * 60 * 1000;

export function InboxClient({ me }: { me: { id: string; role: "admin" | "agent"; displayName: string } }) {
  const isAdmin = me.role === "admin";
  const sb = useMemo(() => supabaseBrowser(), []);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [filter, setFilter] = useState<Filter>("waiting");
  const [lists, setLists] = useState<Record<Filter, Conversation[]>>({ waiting: [], open: [], closed: [] });
  const [counts, setCounts] = useState({ waiting: 0, open: 0 });
  const [scope, setScope] = useState<"all" | "mine">("all");
  const scopeRef = useRef<"all" | "mine">("all");
  scopeRef.current = scope;
  const [history, setHistory] = useState<AssignmentEntry[]>([]);
  const [search, setSearch] = useState("");
  const searchRef = useRef("");
  const loadSeq = useRef(0);
  const [closing, setClosing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestion, setSuggestion] = useState<SuggestionResult | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<number | null>(null);
  const [rawMode, setRawMode] = useState(false); // ส่งตามที่พิมพ์ ไม่แปล
  const [sending, setSending] = useState(false);
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

  // ---------- โหลดรายการแชท ----------
  const loadConvs = useCallback(async () => {
    const columns = "*, contacts(display_name, avatar_url, language), channels(type, name, ai_mode)";
    // กรองที่ฐานข้อมูล ไม่อย่างนั้นจะเห็นแค่ใน 200 แชทล่าสุด
    const seq = ++loadSeq.current;
    const term = searchRef.current.trim();
    const matched = term
      ? (((await sb.rpc("search_conversations", { p_query: term })).data ?? []) as { id: string }[]).map((r) => r.id)
      : null;
    // แยกดึงแต่ละแท็บ แชทจำนวนมากในแท็บหนึ่งจะได้ไม่เบียดอีกแท็บออกจาก 200 แถวแรก และนับจำนวนจริงเกิน 200 ได้
    const base = (status: "open" | "closed") => {
      let query = sb.from("conversations").select(columns, { count: "exact" }).eq("status", status);
      if (matched) query = query.in("id", matched);
      if (scopeRef.current === "mine") query = query.eq("assigned_to", me.id);
      return tagFilterRef.current.length ? query.contains("tags", tagFilterRef.current) : query;
    };
    const [waiting, open_, closed] = await Promise.all([
      base("open").eq("last_direction", "in")
        .order("needs_human", { ascending: false }).order("waiting_since", { ascending: true, nullsFirst: false }).limit(200),
      base("open").order("last_message_at", { ascending: false }).limit(200),
      base("closed").order("closed_at", { ascending: false, nullsFirst: false }).limit(200),
    ]);
    if (seq !== loadSeq.current) return; // ผลของการค้นหาเก่าที่ตอบช้าต้องไม่ทับผลล่าสุด
    const asRows = (r: { data: unknown }) => (r.data ?? []) as Conversation[];
    setLists({ waiting: asRows(waiting), open: asRows(open_), closed: asRows(closed) });
    setCounts({ waiting: waiting.count ?? 0, open: open_.count ?? 0 });
    const rows = [...new Map([...asRows(waiting), ...asRows(open_), ...asRows(closed)].map((c) => [c.id, c])).values()];
    setConvs(rows);
    const open = selectedRef.current;
    if (open && !rows.some((c) => c.id === open)) {
      const { data: one } = await sb.from("conversations").select(columns).eq("id", open).maybeSingle();
      setOpenConv((one as Conversation | null) ?? null);
    }
  }, [sb, me.id]);

  const loadTags = useCallback(async () => {
    const { data } = await sb.from("tags").select("id, name, color, group, sort, active").order("sort").order("name");
    setTags((data ?? []) as Tag[]);
  }, [sb]);

  useEffect(() => { loadConvs(); }, [tagFilter, scope, loadConvs]);

  // จำค่าไว้ในเครื่อง อ่านหลัง mount เพราะฝั่ง server ไม่มี localStorage
  useEffect(() => {
    try {
      if (localStorage.getItem(SCOPE_KEY) === "mine") setScope("mine");
    } catch { /* ใช้ค่าเริ่มต้น */ }
  }, []);

  function changeScope(next: "all" | "mine") {
    setScope(next);
    try { localStorage.setItem(SCOPE_KEY, next); } catch { /* จำไม่ได้ก็ใช้แค่รอบนี้ */ }
  }

  useEffect(() => {
    searchRef.current = search;
    if (!search.trim() && !loadSeq.current) return;
    const wait = setTimeout(() => loadConvs(), 300);
    return () => clearTimeout(wait);
  }, [search, loadConvs]);

  const loadSuggestion = useCallback(async (convId: string) => {
    const { data } = await sb.from("suggestions").select("id, options, needs_human, suggested_tags")
      .eq("conversation_id", convId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    setSuggestion(data ? { id: data.id, options: data.options as SuggestionOption[], needs_human: data.needs_human, suggested_tags: data.suggested_tags as string[] } : null);
  }, [sb]);

  // error ห้ามทำให้หน้าแชทพัง ฝั่ง server log ไว้แล้ว
  const markRead = useCallback((convId: string) => {
    fetch(`/api/conversations/${convId}/read`, { method: "POST" }).catch(() => {});
  }, []);

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
    sb.from("staff").select("id, display_name, active").order("display_name")
      .then(({ data }) => setStaffList((data ?? []) as StaffOption[]));
    sb.from("quick_media").select("id, title, preview_path").order("created_at", { ascending: false }).then(async ({ data }) => {
      const rows = (data ?? []) as QuickMedia[];
      if (!rows.length) return;
      const { data: urls } = await sb.storage.from("quick-media").createSignedUrls(rows.map((r) => r.preview_path), 3600);
      setQuickMedia(rows.map((r, i) => ({ ...r, previewUrl: urls?.[i]?.signedUrl ?? undefined })));
    });
    sb.from("settings").select("value").eq("key", "ai_mode").maybeSingle()
      .then(({ data }) => data && setGlobalMode(data.value as AiMode));

    const ch = sb.channel("inbox")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => loadConvs())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => {
        const m = p.new as Message;
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
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "suggestions" }, (p) => {
        const s = p.new as { id: string; conversation_id: string; options: SuggestionOption[]; needs_human: boolean; suggested_tags: string[] };
        if (s.conversation_id === selectedRef.current) {
          setSuggestion({ id: s.id, options: s.options, needs_human: s.needs_human, suggested_tags: s.suggested_tags });
          setChosen(null);
        }
      })
      .subscribe();
    const t = setInterval(() => setTick((x) => x + 1), 15_000);
    // ข้อความเข้าตอนหน้าต่างไม่โฟกัส: แจ้งอ่านแล้วเมื่อเจ้าหน้าที่กลับมา (server กันเรียก API ซ้ำให้)
    const onFocus = () => {
      if (!selectedRef.current) return;
      markRead(selectedRef.current);
      ensureSuggestion(selectedRef.current, true);
    };
    window.addEventListener("focus", onFocus);
    return () => { sb.removeChannel(ch); clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [sb, loadConvs, loadTags, markRead, ensureSuggestion]);

  // ---------- เลือกแชท ----------
  useEffect(() => {
    if (!selectedId) return;
    setClosing(false);
    setText(""); setChosen(null); setSuggestion(null); setRawMode(false); setAttachment(null); setCaption("");
    sb.from("messages").select("*").eq("conversation_id", selectedId).order("created_at").limit(300)
      .then(({ data }) => setMessages((data ?? []) as Message[]));
    if (draftTimer.current) clearTimeout(draftTimer.current);
    loadSuggestion(selectedId).then(() => ensureSuggestion(selectedId));
    sb.from("conversations").update({ unread_count: 0 }).eq("id", selectedId).then(() => {});
    markRead(selectedId);
  }, [selectedId, sb, loadSuggestion, markRead, ensureSuggestion]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const assignedTo = selected?.assigned_to ?? null;
  useEffect(() => {
    if (!selectedId) return;
    sb.from("assignment_log").select("id, from_staff, to_staff, by_staff, created_at")
      .eq("conversation_id", selectedId).order("created_at", { ascending: false }).limit(20)
      .then(({ data }) => setHistory((data ?? []) as AssignmentEntry[]));
  }, [sb, selectedId, assignedTo]);

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
      body: JSON.stringify({ text, suggestionId: suggestion?.id ?? null, chosenIndex: chosen, skipTranslate: rawMode }),
    });
    setSending(false);
    if (!res.ok) return flash((await res.json().catch(() => ({}))).error ?? "ส่งไม่สำเร็จ");
    setText(""); setChosen(null); setSuggestion(null);
  }

  async function changeTag(tag: string, action: "add" | "remove") {
    if (!selectedId) return;
    const res = await fetch(`/api/conversations/${selectedId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag, action }),
    });
    if (!res.ok) return flash((await res.json().catch(() => ({}))).error ?? "บันทึกแท็กไม่สำเร็จ");
    loadConvs();
  }

  async function assign(to: string | null) {
    if (!selectedId) return;
    const res = await fetch(`/api/conversations/${selectedId}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    });
    if (!res.ok) return flash((await res.json().catch(() => ({}))).error ?? "เปลี่ยนผู้ดูแลไม่สำเร็จ");
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
    if (file.size > MAX_UPLOAD_BYTES) return flash("รูปต้องไม่เกิน 10MB");
    // ชนิดจริงตรวจจาก magic bytes ที่ server ตรงนี้แค่กันเลือกผิด
    setAttachment({ file, previewUrl: URL.createObjectURL(file), name: file.name || "รูปภาพ" });
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
        body: JSON.stringify({ uploadPath, quickMediaId: attachment.quick?.id, caption, skipTranslate: rawMode }),
      });
      if (!res.ok) return flash((await res.json().catch(() => ({}))).error ?? "ส่งรูปไม่สำเร็จ");
      setAttachment(null); setCaption(""); setSuggestion(null); setChosen(null);
    } catch (e) {
      flash(e instanceof Error ? e.message : "ส่งรูปไม่สำเร็จ");
    } finally {
      setSending(false);
    }
  }

  async function setConvMode(mode: AiMode | null) {
    if (!selectedId) return;
    await sb.from("conversations").update({ ai_mode: mode, ...(mode !== "fallback" ? { ai_due_at: null } : {}) }).eq("id", selectedId);
    loadConvs();
  }

  async function reopenCase() {
    if (!selected) return;
    await sb.from("conversations").update({ status: "open" }).eq("id", selected.id);
  }

  async function closeCase(tag?: string) {
    if (!selected) return;
    const id = selected.id;
    setClosing(false);
    if (tag && !selected.tags.includes(tag)) await changeTag(tag, "add");
    const { error } = await sb.from("conversations").update(CLOSE_PATCH).eq("id", id);
    if (error) return flash("บันทึกไม่สำเร็จ");
    setSelectedId(nextOpenChat(lists.waiting, id));
    loadConvs();
  }

  // ใช้ e.code เพราะ e.key เปลี่ยนตามแป้นพิมพ์ไทย/อังกฤษ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.code !== "KeyE") return;
      e.preventDefault();
      if (selected?.status !== "open") return;
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
    if (e.altKey && ["1", "2", "3"].includes(e.key)) { e.preventDefault(); pick(Number(e.key) - 1); }
  }

  const effectiveMode = (c: Conversation): AiMode => c.ai_mode ?? c.channels?.ai_mode ?? globalMode;

  const shown = lists[filter];
  const statusTags = tags.filter((t) => t.group === "status" && t.active);

  const dueMin = selected?.ai_due_at ? Math.max(0, Math.ceil((new Date(selected.ai_due_at).getTime() - Date.now()) / 60000)) : null;
  // กติกา 24 ชม. ของ Facebook/Instagram
  const isMeta = selected?.channels?.type === "facebook" || selected?.channels?.type === "instagram";
  const lastInbound = [...messages].reverse().find((m) => m.direction === "in");
  const inboundAgeH = lastInbound ? (Date.now() - new Date(lastInbound.created_at).getTime()) / 3_600_000 : null;
  const metaWindow = !isMeta || inboundAgeH == null ? null
    : inboundAgeH <= 24 ? null
    : inboundAgeH <= 24 * 7 ? "human" : "closed";
  const suggestedTags = (suggestion?.suggested_tags ?? []).filter((t) => !selected?.tags.includes(t));
  const edited = chosen != null && suggestion?.options[chosen] && suggestion.options[chosen].text !== text;

  return (
    <div className={`inbox ${selected ? "has-chat" : ""}`}>
      {/* ---------- รายการแชท ---------- */}
      <aside className="conv-list">
        <div className="inbox-search">
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหาชื่อ ข้อความ หรือแท็ก…" aria-label="ค้นหาแชท" />
        </div>
        <div className="inbox-tabs" role="tablist" aria-label="สถานะแชท">
          <button role="tab" aria-selected={filter === "open"} className={filter === "open" ? "on" : ""} onClick={() => setFilter("open")}>
            ทั้งหมด {counts.open > 0 && <b className="badge muted-badge">{counts.open}</b>}
          </button>
          <button role="tab" aria-selected={filter === "waiting"} className={filter === "waiting" ? "on" : ""} onClick={() => setFilter("waiting")}>
            🔴 รอตอบ {counts.waiting > 0 && <b className="badge red">{counts.waiting}</b>}
          </button>
          <button role="tab" aria-selected={filter === "closed"} className={filter === "closed" ? "on" : ""} onClick={() => setFilter("closed")}>✅ เสร็จแล้ว</button>
        </div>
        <div className="scope-filter" role="group" aria-label="ขอบเขตแชท">
          <button className={scope === "all" ? "on" : ""} aria-pressed={scope === "all"} onClick={() => changeScope("all")}>ทุกคน</button>
          <button className={scope === "mine" ? "on" : ""} aria-pressed={scope === "mine"} onClick={() => changeScope("mine")}>ของฉัน</button>
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
            {tagFilter.length > 0 && <button className="btn ghost small" onClick={() => setTagFilter([])}>ล้างตัวกรอง</button>}
          </div>
          {tagFilter.length > 1 && <div className="muted small">แสดงแชทที่มีครบทุกแท็กที่เลือก</div>}
        </details>
        {shown.length === 0 && (search.trim() || tagFilter.length || scope === "mine" ? (
          <div className="empty">ไม่พบแชทที่ตรงกับการค้นหาหรือแท็กที่เลือก</div>
        ) : filter === "waiting" ? (
          <div className="all-done">🎉 ตอบครบแล้ว</div>
        ) : (
          <div className="empty">{filter === "closed" ? "ยังไม่มีแชทที่เสร็จแล้ว" : "ยังไม่มีแชท"}</div>
        ))}
        {shown.map((c) => (
          <button key={c.id} className={`conv ${c.id === selectedId ? "active" : ""} ${c.status === "closed" ? "closed" : ""}`}
            onClick={() => setSelectedId(c.id)}>
            <Avatar name={c.contacts?.display_name} url={c.contacts?.avatar_url} />
            <div className="conv-body">
              <div className="conv-top">
                <span className="name">{c.contacts?.display_name || "ลูกค้า"}</span>
                <span className="muted small">{timeTh(c.last_message_at)}</span>
              </div>
              <div className="conv-preview">{c.last_message_preview}</div>
              <div className="chips">
                <span className={`chip ch-${c.channels?.type}`}>{c.channels ? CHANNEL_LABEL[c.channels.type] : ""}</span>
                {c.contacts && c.contacts.language !== "th" && <span className="chip">🌐 {LANGUAGE_NAME[c.contacts.language] ?? c.contacts.language}</span>}
                <span className={`chip mode-${effectiveMode(c)}`}>AI: {AI_MODE_LABEL[effectiveMode(c)]}</span>
                {c.needs_human && <span className="chip red">ต้องให้คนตอบ</span>}
                {filter === "open" && isWaitingForReply(c) && <span className="chip red">รอตอบ</span>}
                {filter === "waiting" && <WaitChip since={c.waiting_since ?? c.last_inbound_at} />}
                {c.tags.map((t) => <TagChip key={t} name={t} color={tagColor.get(t)} />)}
              </div>
            </div>
            {c.assigned_to && (
              <span className="assignee-chip" title={`ผู้ดูแล: ${staffName.get(c.assigned_to) ?? ""}`} aria-label={`ผู้ดูแล ${staffName.get(c.assigned_to) ?? ""}`}>
                {staffInitial(staffName.get(c.assigned_to))}
              </span>
            )}
            {c.unread_count > 0 && <b className="badge">{c.unread_count}</b>}
          </button>
        ))}
      </aside>

      {/* ---------- ห้องแชท ---------- */}
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
            <header className="chat-head">
              <button className="btn ghost small chat-back" aria-label="กลับไปรายการแชท" onClick={() => setSelectedId(null)}>←</button>
              <div className="chat-head-main">
                <div className="name">{selected.contacts?.display_name || "ลูกค้า"}</div>
                <div className="muted small">
                  {selected.channels?.name}
                  {customerLang !== "th" && <> · ลูกค้าใช้ภาษา{LANGUAGE_NAME[customerLang] ?? customerLang} (ระบบแปลให้อัตโนมัติ)</>}
                </div>
                <div className="chips head-tags">
                  {selected.tags.map((t) => (
                    <TagChip key={t} name={t} color={tagColor.get(t)} onRemove={() => changeTag(t, "remove")} />
                  ))}
                  <TagPicker tags={tags} current={selected.tags} onPick={(t) => changeTag(t, "add")} onCreate={isAdmin ? createTag : undefined} />
                </div>
              </div>
              <div className="head-actions">
                <AssigneeControl me={me} assignedTo={selected.assigned_to} staff={staffList} onChange={assign} />
                <label className="mode-select" title={AI_MODE_HINT[effectiveMode(selected)]}>
                  AI แชทนี้
                  <select value={selected.ai_mode ?? ""} disabled={!isAdmin} onChange={(e) => setConvMode((e.target.value || null) as AiMode | null)}>
                    <option value="">ตามช่องทาง ({AI_MODE_LABEL[selected.channels?.ai_mode ?? globalMode]})</option>
                    {(Object.keys(AI_MODE_LABEL) as AiMode[]).map((m) => <option key={m} value={m}>{AI_MODE_LABEL[m]}</option>)}
                  </select>
                </label>
                {selected.status === "open" ? (
                  <div className="close-anchor">
                    <button className="btn done small" title="Ctrl+Shift+E" aria-expanded={closing} onClick={() => setClosing(!closing)}>✓ เสร็จแล้ว</button>
                    {closing && (
                      <CloseCasePopup tags={statusTags} current={selected.tags} hasDraft={!!text.trim() || !!attachment || !!caption.trim()}
                        onChoose={closeCase} onCancel={cancelClosing} />
                    )}
                  </div>
                ) : (
                  <button className="btn ghost small" onClick={reopenCase}>เปิดใหม่</button>
                )}
              </div>
            </header>

            <details className="customer-panel">
              <summary>ข้อมูลลูกค้า</summary>
              <div className="small">ช่องทาง: {selected.channels?.name} · ภาษา: {LANGUAGE_NAME[customerLang] ?? customerLang}</div>
              <div className="small"><b>ประวัติผู้ดูแล</b></div>
              {history.length === 0 && <div className="muted small">ยังไม่มีการเปลี่ยนผู้ดูแล</div>}
              {history.map((h) => (
                <div key={h.id} className="muted small">
                  {timeTh(h.created_at)}: {staffName.get(h.from_staff ?? "") ?? "ไม่มี"} → {staffName.get(h.to_staff ?? "") ?? "ไม่มี"}
                  {h.by_staff && <> (โดย {staffName.get(h.by_staff) ?? "เจ้าหน้าที่"})</>}
                </div>
              ))}
            </details>

            {dueMin != null && (
              <div className="banner">⏱ ถ้าไม่มีใครตอบ AI จะตอบแทนในอีก ~{dueMin} นาที</div>
            )}

            {metaWindow === "human" && (
              <div className="banner">⏳ ลูกค้าทักมาเกิน 24 ชม. แล้ว — เจ้าหน้าที่ยังตอบได้ถึง 7 วัน (AI ตอบแทนไม่ได้)</div>
            )}
            {metaWindow === "closed" && (
              <div className="banner red">⛔ เกิน 7 วันหลังลูกค้าทักล่าสุด {selected.channels?.type === "facebook" ? "Facebook" : "Instagram"} ไม่อนุญาตให้ส่ง ต้องรอลูกค้าทักมาก่อน</div>
            )}

            <div className="messages" ref={listRef}>
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.direction} ${m.sender_type}`}>
                  <div className="bubble">
                    {m.media_type && <ChatImage message={m} />}
                    {(m.body_th ?? m.body) && <div>{m.body_th ?? m.body}</div>}
                    {m.body_th && (
                      <div className="orig">
                        {m.direction === "in" ? "ต้นฉบับ: " : "ส่งจริง: "}{m.body}
                      </div>
                    )}
                  </div>
                  <div className="meta">
                    <span>{senderLabel(m, staffName)}{timeTh(m.created_at)}</span>
                    {m.direction === "out" && <span>{m.read_by_customer_at ? "✓✓ อ่านแล้ว" : "✓ ส่งแล้ว"}</span>}
                    {m.direction === "out" && !m.media_type && (
                      <button className={`star ${m.starred ? "on" : ""}`} title="บันทึกเป็นคำตอบมาตรฐาน"
                        onClick={() => !m.starred && star(m)}>{m.starred ? "★" : "☆"}</button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* ---------- คำแนะนำ ---------- */}
            <div className="suggest">
              <div className="suggest-head">
                <span>💡 คำตอบแนะนำ <span className="muted small">(Alt+1/2/3)</span></span>
                {suggestion?.needs_human && <span className="chip red">⚠️ เรื่องอาการ/ยา/ร้องเรียน — โปรดตรวจก่อนส่ง</span>}
                <button className="btn ghost small" onClick={refreshSuggestions} disabled={suggesting}>
                  {suggesting ? "กำลังคิด…" : "↻ แนะนำใหม่"}
                </button>
              </div>
              {suggestedTags.length > 0 && (
                <div className="ai-tags">
                  <span className="muted small">AI แนะนำ:</span>
                  {suggestedTags.map((t) => (
                    <button key={t} className="ai-tag" aria-label={`ติดแท็ก ${t}`} onClick={() => changeTag(t, "add")}>{t} ✓</button>
                  ))}
                </div>
              )}
              <div className="sugg-list">
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
              </div>
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
                  <img src={attachment.previewUrl} alt={attachment.name} />
                  <input value={caption} onChange={(e) => setCaption(e.target.value)} onKeyDown={onKey}
                    placeholder="คำบรรยายรูป (ไม่ใส่ก็ได้)" aria-label="คำบรรยายรูป" />
                  <button className="btn ghost small" onClick={() => { setAttachment(null); setCaption(""); }}>ยกเลิก</button>
                </div>
              )}
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                onPaste={onPaste}
                placeholder={customerLang !== "th" && !rawMode ? "พิมพ์ภาษาไทย ระบบจะแปลให้ลูกค้า… (Ctrl+Enter ส่ง)" : "พิมพ์ข้อความ… (Ctrl+Enter ส่ง)"}
              />
              <div className="composer-foot">
                <div className="muted small">
                  <button className="btn ghost small attach-btn" title="แนบรูป (ลากวาง หรือ Ctrl+V ได้)" aria-label="แนบรูป"
                    onClick={() => fileInput.current?.click()}>📎</button>
                  <input ref={fileInput} type="file" accept="image/*,.heic,.heif" hidden
                    onChange={(e) => { attachFile(e.target.files?.[0]); e.target.value = ""; }} />
                  {chosen != null && (edited ? "✏️ แก้จากคำแนะนำ — ระบบจะจำสำนวนนี้" : "✅ ใช้คำแนะนำตามเดิม")}
                  {customerLang !== "th" && (
                    <label className="raw">
                      <input type="checkbox" checked={rawMode} onChange={(e) => setRawMode(e.target.checked)} />
                      ส่งตามที่พิมพ์ (ไม่แปล)
                    </label>
                  )}
                </div>
                {attachment ? (
                  <button className="btn primary" onClick={sendAttachment} disabled={sending || metaWindow === "closed"}>
                    {sending ? "กำลังส่ง…" : "ส่งรูป"}
                  </button>
                ) : (
                  <button className="btn primary" onClick={send} disabled={sending || !text.trim() || metaWindow === "closed"}>
                    {sending ? "กำลังส่ง…" : customerLang !== "th" && !rawMode ? `แปล & ส่ง` : "ส่ง"}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>
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

/** ผู้ส่งข้อความขาออก เช่น "Admin · " หรือ "🤖 AI · " ข้อความลูกค้าไม่ต้องแสดง */
function senderLabel(m: Message, names: Map<string, string>): string {
  if (m.direction !== "out") return "";
  if (m.sender_type === "ai") return "🤖 AI · ";
  return `${(m.sender_id && names.get(m.sender_id)) || "เจ้าหน้าที่"} · `;
}

function WaitChip({ since }: { since: string | null }) {
  const badge = waitBadge(since);
  return badge ? <span className={`chip wait-${badge.level}`}>{badge.text}</span> : null;
}

function Avatar({ name, url }:{ name?: string | null; url?: string | null }) {
  if (url) return <img className="avatar" src={url} alt="" />;
  return <div className="avatar">{(name || "?").slice(0, 1)}</div>;
}
