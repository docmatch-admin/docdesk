"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

interface StaffOption { id: string; display_name: string; active: boolean; role?: string; can_view_sensitive?: boolean }
interface Task { id: string; conversation_id: string; text: string; assignee_id: string | null; done: boolean; done_by: string | null; done_at: string | null; created_by: string | null; created_at: string }
interface Note { id: string; conversation_id: string; task_id: string | null; body: string; author_id: string | null; created_at: string }

const timeTh = (iso: string) =>
  new Date(iso).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

/**
 * งานของทีมและคอมเมนต์ภายใน: อ่านผ่าน RLS เขียนผ่าน API
 * ทุกอย่างในกล่องนี้ลูกค้าไม่เห็น เพราะเก็บแยกจาก messages
 */
export function TeamPanel({ conversationId, staff, sensitive, onChanged, onError }: {
  conversationId: string;
  staff: StaffOption[];
  sensitive: boolean;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [tasks, setTasks] = useState<Task[]>([]);
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
    load();
    // เจ้าหน้าที่คนอื่นเพิ่มงานหรือคอมเมนต์ก็เห็นทันที
    const filter = `conversation_id=eq.${conversationId}`;
    const ch = sb.channel(`team-${conversationId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_tasks", filter }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_notes", filter }, () => load())
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [sb, conversationId, load]);

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
    if (await call("tasks", "POST", { text: newTask, assignee_id: assignee || null })) { setNewTask(""); setAssignee(""); }
  }

  async function addNote(e: React.FormEvent, taskId: string | null) {
    e.preventDefault();
    const body = taskId ? reply : newNote;
    if (!body.trim()) return;
    if (await call("notes", "POST", { body, task_id: taskId })) {
      if (taskId) setReply(""); else setNewNote("");
    }
  }

  const doneCount = tasks.filter((t) => t.done).length;
  const chatNotes = notes.filter((n) => !n.task_id);
  const threadOf = (id: string) => notes.filter((n) => n.task_id === id);
  const who = (id: string | null) => (id && name.get(id)) || "เจ้าหน้าที่";

  return (
    <aside className="team-panel" aria-label="งานของทีมและคอมเมนต์ภายใน">
      <section className="team-box">
        <div className="team-head">
          <h3>งานของทีม</h3>
          {tasks.length > 0 && <span className={`chip ${doneCount < tasks.length ? "orange" : ""}`}>{doneCount}/{tasks.length} เสร็จ</span>}
        </div>
        {tasks.length === 0 && <div className="muted small">ยังไม่มีงาน</div>}
        <ul className="task-list">
          {tasks.map((t) => {
            const thread = threadOf(t.id);
            const expanded = openThread === t.id;
            const latest = thread.at(-1);
            return (
              <li key={t.id} className={`task ${t.done ? "done" : ""}`}>
                <label className="task-check">
                  <input type="checkbox" checked={t.done} disabled={busy}
                    onChange={(e) => call("tasks", "PATCH", { task_id: t.id, done: e.target.checked })} />
                  <span className="task-text">{t.text}</span>
                </label>
                <div className="task-meta muted small">
                  {t.assignee_id && <span>👤 {who(t.assignee_id)}</span>}
                  {t.done && t.done_at && <span>✓ {who(t.done_by)} · {timeTh(t.done_at)}</span>}
                  <button type="button" className="link-btn" aria-expanded={expanded}
                    onClick={() => { setOpenThread(expanded ? null : t.id); setReply(""); }}>คอมเมนต์ {thread.length}</button>
                </div>
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
                    <form className="note-form" onSubmit={(e) => addNote(e, t.id)}>
                      <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="คอมเมนต์งานนี้…" aria-label="คอมเมนต์งานนี้" maxLength={2000} />
                      <button className="btn small" disabled={busy || !reply.trim()}>ส่ง</button>
                    </form>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <form className="task-form" onSubmit={addTask}>
          <input value={newTask} onChange={(e) => setNewTask(e.target.value)} placeholder="เพิ่มงาน เช่น โทรยืนยันนัด" aria-label="เพิ่มงาน" maxLength={500} />
          <div className="row">
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="ผู้รับงาน">
              <option value="">ไม่ระบุผู้รับ</option>
              {assignable.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
            </select>
            <button className="btn small" disabled={busy || !newTask.trim()}>เพิ่มงาน</button>
          </div>
        </form>
      </section>

      <section className="team-box internal-notes">
        <div className="team-head">
          <h3>คอมเมนต์ภายใน</h3>
          <span className="chip internal-badge">ลูกค้าไม่เห็น</span>
        </div>
        {chatNotes.length === 0 && <div className="muted small">ยังไม่มีคอมเมนต์</div>}
        {chatNotes.map((n) => (
          <div key={n.id} className="note small">
            <div className="note-by muted">{who(n.author_id)} · {timeTh(n.created_at)}</div>
            <div className="note-body">{n.body}</div>
          </div>
        ))}
        <form className="note-form" onSubmit={(e) => addNote(e, null)}>
          <textarea rows={2} value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="บันทึกถึงทีม ลูกค้าไม่เห็น" aria-label="คอมเมนต์ภายใน" maxLength={2000} />
          <button className="btn small" disabled={busy || !newNote.trim()}>บันทึก</button>
        </form>
      </section>
    </aside>
  );
}
