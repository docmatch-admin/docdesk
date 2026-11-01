"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { LANGUAGE_NAME } from "@/lib/translate-names";
import {
  AI_MODE_HINT, AI_MODE_LABEL, CHANNEL_LABEL,
  type AiMode, type Conversation, type Message, type SuggestionOption, type SuggestionResult,
} from "@/lib/types";

type Filter = "all" | "human" | "unread";

const SOURCE_LABEL: Record<SuggestionOption["source"], string> = {
  knowledge: "📚 ฐานข้อมูล",
  example: "💬 คำตอบเดิม",
  history: "🕘 ประวัติลูกค้า",
};

const timeTh = (iso: string) =>
  new Date(iso).toLocaleString("th-TH", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", timeZone: "Asia/Bangkok" });

export function InboxClient() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
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

  const selected = convs.find((c) => c.id === selectedId) ?? null;
  const customerLang = selected?.contacts?.language ?? "th";

  // ---------- โหลดรายการแชท ----------
  const loadConvs = useCallback(async () => {
    const { data } = await sb
      .from("conversations")
      .select("*, contacts(display_name, avatar_url, language), channels(type, name, ai_mode)")
      .order("last_message_at", { ascending: false })
      .limit(200);
    setConvs((data ?? []) as Conversation[]);
  }, [sb]);

  const loadSuggestion = useCallback(async (convId: string) => {
    const { data } = await sb.from("suggestions").select("id, options, needs_human")
      .eq("conversation_id", convId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    setSuggestion(data ? { id: data.id, options: data.options as SuggestionOption[], needs_human: data.needs_human } : null);
  }, [sb]);

  // error ห้ามทำให้หน้าแชทพัง ฝั่ง server log ไว้แล้ว
  const markRead = useCallback((convId: string) => {
    fetch(`/api/conversations/${convId}/read`, { method: "POST" }).catch(() => {});
  }, []);

  useEffect(() => {
    loadConvs();
    sb.from("settings").select("value").eq("key", "ai_mode").maybeSingle()
      .then(({ data }) => data && setGlobalMode(data.value as AiMode));

    const ch = sb.channel("inbox")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => loadConvs())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => {
        const m = p.new as Message;
        if (m.conversation_id === selectedRef.current) {
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
          if (m.direction === "in" && document.hasFocus()) markRead(m.conversation_id);
        }
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, (p) => {
        const m = p.new as Message;
        if (m.conversation_id === selectedRef.current) {
          setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...m } : x)));
        }
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "suggestions" }, (p) => {
        const s = p.new as { id: string; conversation_id: string; options: SuggestionOption[]; needs_human: boolean };
        if (s.conversation_id === selectedRef.current) {
          setSuggestion({ id: s.id, options: s.options, needs_human: s.needs_human });
          setChosen(null);
        }
      })
      .subscribe();
    const t = setInterval(() => setTick((x) => x + 1), 15_000);
    // ข้อความเข้าตอนหน้าต่างไม่โฟกัส: แจ้งอ่านแล้วเมื่อเจ้าหน้าที่กลับมา (server กันเรียก API ซ้ำให้)
    const onFocus = () => { if (selectedRef.current) markRead(selectedRef.current); };
    window.addEventListener("focus", onFocus);
    return () => { sb.removeChannel(ch); clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [sb, loadConvs, markRead]);

  // ---------- เลือกแชท ----------
  useEffect(() => {
    if (!selectedId) return;
    setText(""); setChosen(null); setSuggestion(null); setRawMode(false);
    sb.from("messages").select("*").eq("conversation_id", selectedId).order("created_at").limit(300)
      .then(({ data }) => setMessages((data ?? []) as Message[]));
    loadSuggestion(selectedId);
    sb.from("conversations").update({ unread_count: 0 }).eq("id", selectedId).then(() => {});
    markRead(selectedId);
  }, [selectedId, sb, loadSuggestion, markRead]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

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

  async function setConvMode(mode: AiMode | null) {
    if (!selectedId) return;
    await sb.from("conversations").update({ ai_mode: mode, ...(mode !== "fallback" ? { ai_due_at: null } : {}) }).eq("id", selectedId);
    loadConvs();
  }

  async function toggleStatus() {
    if (!selected) return;
    await sb.from("conversations").update({ status: selected.status === "open" ? "closed" : "open", needs_human: false }).eq("id", selected.id);
  }

  async function star(m: Message) {
    const res = await fetch(`/api/messages/${m.id}/star`, { method: "POST" });
    if (res.ok) {
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, starred: true } : x)));
      flash("บันทึกเป็นคำตอบมาตรฐานแล้ว ⭐");
    } else flash("บันทึกไม่สำเร็จ");
  }

  function onKey(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); }
    if (e.altKey && ["1", "2", "3"].includes(e.key)) { e.preventDefault(); pick(Number(e.key) - 1); }
  }

  const effectiveMode = (c: Conversation): AiMode => c.ai_mode ?? c.channels?.ai_mode ?? globalMode;

  const shown = convs.filter((c) =>
    filter === "all" ? true : filter === "human" ? c.needs_human : c.unread_count > 0);
  const counts = {
    human: convs.filter((c) => c.needs_human).length,
    unread: convs.filter((c) => c.unread_count > 0).length,
  };

  const dueMin = selected?.ai_due_at ? Math.max(0, Math.ceil((new Date(selected.ai_due_at).getTime() - Date.now()) / 60000)) : null;
  // กติกา 24 ชม. ของ Facebook/Instagram
  const isMeta = selected?.channels?.type === "facebook" || selected?.channels?.type === "instagram";
  const lastInbound = [...messages].reverse().find((m) => m.direction === "in");
  const inboundAgeH = lastInbound ? (Date.now() - new Date(lastInbound.created_at).getTime()) / 3_600_000 : null;
  const metaWindow = !isMeta || inboundAgeH == null ? null
    : inboundAgeH <= 24 ? null
    : inboundAgeH <= 24 * 7 ? "human" : "closed";
  const edited = chosen != null && suggestion?.options[chosen] && suggestion.options[chosen].text !== text;

  return (
    <div className="inbox">
      {/* ---------- รายการแชท ---------- */}
      <aside className="conv-list">
        <div className="tabs">
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>ทั้งหมด</button>
          <button className={filter === "human" ? "on" : ""} onClick={() => setFilter("human")}>
            รอคนตอบ {counts.human > 0 && <b className="badge red">{counts.human}</b>}
          </button>
          <button className={filter === "unread" ? "on" : ""} onClick={() => setFilter("unread")}>
            ยังไม่อ่าน {counts.unread > 0 && <b className="badge">{counts.unread}</b>}
          </button>
        </div>
        {shown.length === 0 && <div className="empty">ยังไม่มีแชท</div>}
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
              </div>
            </div>
            {c.unread_count > 0 && <b className="badge">{c.unread_count}</b>}
          </button>
        ))}
      </aside>

      {/* ---------- ห้องแชท ---------- */}
      <section className="chat">
        {!selected ? (
          <div className="empty big">เลือกแชททางซ้ายเพื่อเริ่มตอบ</div>
        ) : (
          <>
            <header className="chat-head">
              <div>
                <div className="name">{selected.contacts?.display_name || "ลูกค้า"}</div>
                <div className="muted small">
                  {selected.channels?.name}
                  {customerLang !== "th" && <> · ลูกค้าใช้ภาษา{LANGUAGE_NAME[customerLang] ?? customerLang} (ระบบแปลให้อัตโนมัติ)</>}
                </div>
              </div>
              <div className="head-actions">
                <label className="mode-select" title={AI_MODE_HINT[effectiveMode(selected)]}>
                  AI แชทนี้
                  <select value={selected.ai_mode ?? ""} onChange={(e) => setConvMode((e.target.value || null) as AiMode | null)}>
                    <option value="">ตามช่องทาง ({AI_MODE_LABEL[selected.channels?.ai_mode ?? globalMode]})</option>
                    {(Object.keys(AI_MODE_LABEL) as AiMode[]).map((m) => <option key={m} value={m}>{AI_MODE_LABEL[m]}</option>)}
                  </select>
                </label>
                <button className="btn ghost small" onClick={toggleStatus}>{selected.status === "open" ? "ปิดเคส" : "เปิดเคส"}</button>
              </div>
            </header>

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
                    <div>{m.direction === "in" ? (m.body_th ?? m.body) : (m.body_th ?? m.body)}</div>
                    {m.body_th && (
                      <div className="orig">
                        {m.direction === "in" ? "ต้นฉบับ: " : "ส่งจริง: "}{m.body}
                      </div>
                    )}
                  </div>
                  <div className="meta">
                    {m.sender_type === "ai" && <span className="chip mode-auto">🤖 AI</span>}
                    {timeTh(m.created_at)}
                    {m.direction === "out" && <span>{m.read_by_customer_at ? "✓✓ อ่านแล้ว" : "✓ ส่งแล้ว"}</span>}
                    {m.direction === "out" && (
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
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                placeholder={customerLang !== "th" && !rawMode ? "พิมพ์ภาษาไทย ระบบจะแปลให้ลูกค้า… (Ctrl+Enter ส่ง)" : "พิมพ์ข้อความ… (Ctrl+Enter ส่ง)"}
              />
              <div className="composer-foot">
                <div className="muted small">
                  {chosen != null && (edited ? "✏️ แก้จากคำแนะนำ — ระบบจะจำสำนวนนี้" : "✅ ใช้คำแนะนำตามเดิม")}
                  {customerLang !== "th" && (
                    <label className="raw">
                      <input type="checkbox" checked={rawMode} onChange={(e) => setRawMode(e.target.checked)} />
                      ส่งตามที่พิมพ์ (ไม่แปล)
                    </label>
                  )}
                </div>
                <button className="btn primary" onClick={send} disabled={sending || !text.trim() || metaWindow === "closed"}>
                  {sending ? "กำลังส่ง…" : customerLang !== "th" && !rawMode ? `แปล & ส่ง` : "ส่ง"}
                </button>
              </div>
            </div>
          </>
        )}
      </section>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Avatar({ name, url }: { name?: string | null; url?: string | null }) {
  if (url) return <img className="avatar" src={url} alt="" />;
  return <div className="avatar">{(name || "?").slice(0, 1)}</div>;
}
