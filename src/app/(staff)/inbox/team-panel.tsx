"use client";

import { thaiDateTime } from "@/lib/time-format";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { useLiveChannel } from "@/lib/use-live-channel";
import { chatBundle } from "@/lib/chat-bundle";
import { Icon } from "../icons";

interface StaffOption { id: string; display_name: string; active: boolean; role?: string; can_view_sensitive?: boolean }
interface Task { id: string; conversation_id: string; text: string; assignee_id: string | null; done: boolean; done_by: string | null; done_at: string | null; created_by: string | null; created_at: string }
interface Note { id: string; conversation_id: string; task_id: string | null; body: string; author_id: string | null; created_at: string }

const timeTh = (iso: string) => thaiDateTime(iso);

/**
 * งานของทีมและคอมเมนต์ภายใน: อ่านผ่าน RLS เขียนผ่าน API
 * ทุกอย่างในกล่องนี้ลูกค้าไม่เห็น เพราะเก็บแยกจาก messages
 */
export function TeamPanel({ conversationId, staff, sensitive, closed = false, onChanged, onError, onNoteCount, onFirstTask, children }: {
  conversationId: string;
  /** แชทปิดแล้ว (เสร็จแล้ว): ซ่อนงานที่เสร็จแล้วทันที (ลบถาวรเมื่อปิดครบระยะเก็บ) */
  closed?: boolean;
  staff: StaffOption[];
  sensitive: boolean;
  onChanged: () => void;
  onError: (msg: string) => void;
  /** จำนวนคอมเมนต์ภายในของแชท (ป้ายบนแท็บคอมเมนต์ในมือถือ) */
  onNoteCount?: (n: number) => void;
  /** งานค้างงานแรก (แถบงานค้างในแท็บแชทมือถือ) */
  onFirstTask?: (text: string | null) => void;
  /** แทรกระหว่างงานของทีมกับความเห็นภายใน (ประวัติที่คลินิก) ตามลำดับในแบบ */
  children?: React.ReactNode;
}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [adding, setAdding] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [newTask, setNewTask] = useState("");
  const [assignee, setAssignee] = useState("");
  const [newNote, setNewNote] = useState("");
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const name = useMemo(() => new Map(staff.map((s) => [s.id, s.display_name])), [staff]);
  // แชทลับมอบงานได้เฉพาะคนที่เปิดแชทลับได้ เหมือนการเลือกผู้ดูแล
  const assignable = staff.filter((s) => s.active && (!sensitive || s.role === "admin" || s.can_view_sensitive));

  const load = useCallback(async () => {
    const [{ data: t }, { data: n }] = await Promise.all([
      sb.from("chat_tasks").select("*").eq("conversation_id", conversationId).order("created_at"),
      sb.from("chat_notes").select("*").eq("conversation_id", conversationId).order("created_at"),
    ]);
    setTasks((t ?? []) as Task[]);
    setNotes((n ?? []) as Note[]);
  }, [sb, conversationId]);

  useEffect(() => {
    setTasks([]); setNotes([]); setOpenThread(null); setReply(""); setNewTask(""); setNewNote(""); setAssignee("");
    // ตอนเปิดแชทใช้ข้อมูลชุดเดียวกับห้องแชท (ไม่ยิงแยก)
    let alive = true;
    chatBundle(conversationId).then((b) => {
      if (!alive) return;
      if (!b?.tasks || !b.notes) return void load();
      setTasks(b.tasks as Task[]);
      setNotes(b.notes as Note[]);
    });
    return () => { alive = false; };
  }, [conversationId, load]);
  // เจ้าหน้าที่คนอื่นเพิ่มงานหรือคอมเมนต์ก็เห็นทันที (หลุดแล้วต่อใหม่เอง)
  useLiveChannel(sb, `team-${conversationId}`, (ch) => ch
    .on("postgres_changes", { event: "*", schema: "public", table: "chat_tasks", filter: `conversation_id=eq.${conversationId}` }, () => load())
    .on("postgres_changes", { event: "*", schema: "public", table: "chat_notes", filter: `conversation_id=eq.${conversationId}` }, () => load()),
    () => load());

  async function call(path: string, method: "POST" | "PATCH", body: unknown): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        onError((await res.json().catch(() => ({}))).error ?? "บันทึกไม่สำเร็จ");
        return false;
      }
      await load();
      onChanged();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function addTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTask.trim()) return;
    if (await call("tasks", "POST", { text: newTask, assignee_id: assignee || null })) { setNewTask(""); setAssignee(""); setAdding(false); }
  }

  async function addNote(e: React.FormEvent, taskId: string | null) {
    e.preventDefault();
    const body = taskId ? reply : newNote;
    if (!body.trim()) return;
    if (await call("notes", "POST", { body, task_id: taskId })) {
      if (taskId) setReply(""); else setNewNote("");
    }
  }

  // งานค้างแสดงเสมอ · งานที่เสร็จแล้ว: แชทปิด = ซ่อน · แชทเปิด (รวมเปิดใหม่ภายในระยะเก็บ) = ส่วนย่อ "งานที่เสร็จแล้ว (N)"
  const pending = tasks.filter((t) => !t.done);
  const finished = tasks.filter((t) => t.done);
  const doneCount = finished.length;
  const chatNotes = notes.filter((n) => !n.task_id);
  useEffect(() => { onNoteCount?.(chatNotes.length); }, [chatNotes.length, onNoteCount]);
  const firstPending = pending[0]?.text ?? null;
  useEffect(() => { onFirstTask?.(firstPending); }, [firstPending, onFirstTask]);
  const threadOf = (id: string) => notes.filter((n) => n.task_id === id);
  const who = (id: string | null) => (id && name.get(id)) || "เจ้าหน้าที่";

  const renderTask = (t: Task) => {
      const thread = threadOf(t.id);
      const expanded = openThread === t.id;
      const latest = thread.at(-1);
      return (
        <li key={t.id} className={`task ${t.done ? "done" : ""}`}>
          <label className="task-check">
            <input type="checkbox" checked={t.done} disabled={busy}
              onChange={(e) => call("tasks", "PATCH", { task_id: t.id, done: e.target.checked })} />
            <span className="task-body">
              <span className="task-text">{t.text}</span>
              <span className="task-sub">
                {t.done && t.done_at ? `เสร็จโดย ${who(t.done_by)} · ${timeTh(t.done_at)}` : t.assignee_id ? who(t.assignee_id) : "ไม่ระบุผู้รับ"}
                {" · "}
                <button type="button" className="link-btn task-thread-btn" aria-expanded={expanded}
                  onClick={(e) => { e.preventDefault(); setOpenThread(expanded ? null : t.id); setReply(""); }}>{expanded ? "ซ่อนความเห็น" : thread.length ? `${thread.length} ความเห็น` : "เพิ่มความเห็น"}</button>
              </span>
            </span>
          </label>
          {!expanded && latest && (
            <div className="task-latest small"><b>{who(latest.author_id)}:</b> {latest.body}</div>
          )}
          {expanded && (
            <div className="task-thread">
              {thread.map((n) => (
                <div key={n.id} className="note small">
                  <div className="note-by muted">{who(n.author_id)} · {timeTh(n.created_at)}</div>
                  <div className="note-body">{n.body}</div>
                </div>
              ))}
              <form className="inline-form" onSubmit={(e) => addNote(e, t.id)}>
                <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="ความเห็นต่องานนี้…" aria-label="ความเห็นต่องานนี้" maxLength={2000} />
                <button className="icon-btn dark" disabled={busy || !reply.trim()} aria-label="ส่งคอมเมนต์งานนี้" title="ส่ง"><Icon name="send" /></button>
              </form>
            </div>
          )}
        </li>
      );
};

  return (
    <>
      <section className="side-block tp-tasks">
        <h3 className="side-title">งานของทีม{pending.length > 0 ? ` (ค้าง ${pending.length})` : ""}</h3>
        {pending.length === 0 && (closed || finished.length === 0) && <div className="muted small">{closed && finished.length ? "ไม่มีงานค้าง (งานที่เสร็จแล้วถูกซ่อนเมื่อปิดแชท)" : "ยังไม่มีงานค้าง"}</div>}
        <ul className="task-list">
          {pending.map(renderTask)}
        </ul>
        {!closed && finished.length > 0 && (
          <details className="task-done-fold">
            <summary>งานที่เสร็จแล้ว ({finished.length})</summary>
            <ul className="task-list">{finished.map(renderTask)}</ul>
          </details>
        )}
        {adding ? (
          <form className="task-form" onSubmit={async (e) => { await addTask(e); }}>
            <div className="inline-form">
              <input autoFocus value={newTask} onChange={(e) => setNewTask(e.target.value)} placeholder="เพิ่มงาน เช่น โทรยืนยันนัด" aria-label="เพิ่มงาน" maxLength={500}
                onKeyDown={(e) => { if (e.key === "Escape") setAdding(false); }} />
              <button className="icon-btn dark" disabled={busy || !newTask.trim()} aria-label="เพิ่มงาน" title="เพิ่มงาน"><Icon name="plus" /></button>
            </div>
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="ผู้รับงาน">
              <option value="">ไม่ระบุผู้รับ</option>
              {assignable.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
            </select>
          </form>
        ) : (
          <button type="button" className="task-add" onClick={() => setAdding(true)}>+ เพิ่มงาน</button>
        )}
      </section>

      {children}

      <section className="side-block internal-notes">
        <h3 className="side-title">ความเห็นภายใน</h3>
        {chatNotes.length === 0 && <div className="muted small">ยังไม่มีความเห็น (ลูกค้าไม่เห็น)</div>}
        {chatNotes.map((n) => (
          <div key={n.id} className="note">
            <div className="note-body">{n.body}</div>
            <div className="note-by">{who(n.author_id)} · {timeTh(n.created_at)}</div>
          </div>
        ))}
      </section>

      {/* ช่องเขียนความเห็นติดล่างแผง (ตามแบบ) · ลูกค้าไม่เห็น */}
      <form className="note-compose" onSubmit={(e) => addNote(e, null)}>
        <input value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="เขียนความเห็นถึงทีม…" aria-label="เขียนความเห็นภายใน (ลูกค้าไม่เห็น)" maxLength={2000} />
        <button className="note-send" disabled={busy || !newNote.trim()} aria-label="ส่งความเห็น" title="ส่งความเห็น (ลูกค้าไม่เห็น)"><Icon name="send" size={18} /></button>
      </form>
    </>
  );
}
