import { supabaseAdmin } from "./supabase/admin";

/**
 * งานของทีมและคอมเมนต์ภายใน: เก็บแยกจาก messages จึงไม่มีทางถูกส่งถึงลูกค้า
 * ไม่ถูกแสดงใน widget และไม่ถูกส่งให้ AI เพราะทุกเส้นทางเหล่านั้นอ่านจาก messages เท่านั้น
 */
export const TASK_MAX_CHARS = 500;
export const NOTE_MAX_CHARS = 2000;

export type TeamProblem = "not_found" | "invalid" | "assignee";

export const openTasksText = (n: number) => `เหลือ ${n} งานที่ยังไม่เสร็จ`;

export async function countOpenTasks(conversationId: string): Promise<number> {
  const { data } = await supabaseAdmin().from("chat_tasks").select("id")
    .eq("conversation_id", conversationId).eq("done", false);
  return data?.length ?? 0;
}

/** เพิ่มงานหรือยกเลิกติ๊กในแชทที่เสร็จแล้ว: กลับมารอตอบ เพราะยังมีงานต้องทำ */
async function reopenIfClosed(conversationId: string) {
  await supabaseAdmin().from("conversations").update({ status: "open" }).eq("id", conversationId).eq("status", "closed");
}

/** ผู้รับงานต้องเป็นเจ้าหน้าที่ที่ใช้งานอยู่ และอ่านแชทลับได้ถ้าแชทนี้เป็นแชทลับ */
async function validAssignee(assigneeId: string, sensitive: boolean): Promise<boolean> {
  const { data } = await supabaseAdmin().from("staff").select("active, role, can_view_sensitive").eq("id", assigneeId).maybeSingle();
  return !!data?.active && data.role !== "pharmacy" && (!sensitive || data.role === "admin" || !!data.can_view_sensitive);
}

export async function createTask(conversationId: string, input: { text?: unknown; assigneeId?: unknown }, staffId: string) {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || [...text].length > TASK_MAX_CHARS) return "invalid" as const;
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("id, sensitive").eq("id", conversationId).maybeSingle();
  if (!conv) return "not_found" as const;
  const assigneeId = typeof input.assigneeId === "string" && input.assigneeId ? input.assigneeId : null;
  if (assigneeId && !(await validAssignee(assigneeId, !!conv.sensitive))) return "assignee" as const;
  const { data, error } = await db.from("chat_tasks")
    .insert({ conversation_id: conversationId, text, assignee_id: assigneeId, done: false, created_by: staffId })
    .select("id, conversation_id, text, assignee_id, done, done_by, done_at, created_by, created_at").single();
  if (error || !data) throw error ?? new Error("task insert failed");
  await reopenIfClosed(conversationId);
  return data;
}

/** ติ๊กเสร็จบันทึกคนและเวลา ยกเลิกติ๊กล้างทั้งคู่และเปิดแชทที่เสร็จแล้วกลับมา */
export async function setTaskDone(conversationId: string, taskId: string, done: boolean, staffId: string) {
  const db = supabaseAdmin();
  const { data: task } = await db.from("chat_tasks").select("id, done").eq("id", taskId).eq("conversation_id", conversationId).maybeSingle();
  if (!task) return "not_found" as const;
  const patch = done ? { done: true, done_by: staffId, done_at: new Date().toISOString() } : { done: false, done_by: null, done_at: null };
  const { data, error } = await db.from("chat_tasks").update(patch).eq("id", taskId)
    .select("id, conversation_id, text, assignee_id, done, done_by, done_at, created_by, created_at").single();
  if (error || !data) throw error ?? new Error("task update failed");
  if (!done) await reopenIfClosed(conversationId);
  return data;
}

/** คอมเมนต์ภายในของแชท หรือของงานถ้าระบุ taskId */
export async function addNote(conversationId: string, input: { body?: unknown; taskId?: unknown }, staffId: string) {
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body || [...body].length > NOTE_MAX_CHARS) return "invalid" as const;
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("id").eq("id", conversationId).maybeSingle();
  if (!conv) return "not_found" as const;
  const taskId = typeof input.taskId === "string" && input.taskId ? input.taskId : null;
  if (taskId) {
    const { data: task } = await db.from("chat_tasks").select("id").eq("id", taskId).eq("conversation_id", conversationId).maybeSingle();
    if (!task) return "not_found" as const;
  }
  const { data, error } = await db.from("chat_notes")
    .insert({ conversation_id: conversationId, task_id: taskId, body, author_id: staffId })
    .select("id, conversation_id, task_id, body, author_id, created_at").single();
  if (error || !data) throw error ?? new Error("note insert failed");
  return data;
}
