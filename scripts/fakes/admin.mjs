// แทน src/lib/supabase/admin.ts ในเทสต์: ฐานข้อมูลในหน่วยความจำ
let seq = 0;
let clock = Date.parse("2026-11-01T03:00:00Z");
export const state = { tables: {}, matchExamples: [], matchKnowledge: [], files: {} };

export function nextTime() { clock += 1000; return new Date(clock).toISOString(); }
export function setClock(iso) { clock = Date.parse(iso) - 1000; }
// เหมือนฟังก์ชัน retention_delete_* ในฐานข้อมูล (migration 055): ตรวจเงื่อนไข บันทึกสถิติ ลบ
const R = await import("../../src/lib/retention-rules.ts");
function retentionDelete(fn, limit) {
  if (!(limit >= 1 && limit <= 500)) throw new Error("batch ต้องอยู่ระหว่าง 1–500 แถว");
  const t = state.tables;
  const setting = (k, d) => R.normalizeRetentionDays(t.settings?.find((x) => x.key === k)?.value, d);
  const stats = (t.retention_stats ??= []);
  const bump = (month, metric, dim, key, n) => {
    const row = stats.find((x) => x.month === month && x.metric === metric && x.dim === dim && x.key === key);
    if (row) row.count += n; else stats.push({ month, metric, dim, key, count: n });
  };
  const now = Date.now();
  if (fn === "retention_delete_tasks") {
    const days = setting(R.RETENTION_SETTING_KEYS.taskDays, R.RETENTION_DEFAULTS.taskDays);
    const conv = (id) => (t.conversations ?? []).find((c) => c.id === id);
    const victims = (t.chat_tasks ?? []).filter((x) => R.taskExpired(x, conv(x.conversation_id), now, days))
      .sort((a, b) => conv(a.conversation_id).closed_at.localeCompare(conv(b.conversation_id).closed_at)).slice(0, limit);
    const ids = new Set(victims.map((v) => v.id));
    for (const v of victims) bump(R.monthOf(v.done_at), "tasks_done", "assignee", v.assignee_id ?? "none", 1);
    const notes = (t.chat_notes ?? []).filter((n) => ids.has(n.task_id)).length;
    t.chat_notes = (t.chat_notes ?? []).filter((n) => !ids.has(n.task_id));
    t.chat_tasks = (t.chat_tasks ?? []).filter((x) => !ids.has(x.id));
    return { tasks: victims.length, notes };
  }
  const days = setting(R.RETENTION_SETTING_KEYS.cancelledAppointmentDays, R.RETENTION_DEFAULTS.cancelledAppointmentDays);
  const today = new Date(now + 7 * 3600_000).toISOString().slice(0, 10);
  const victims = (t.appointments ?? []).filter((a) => R.cancelledAppointmentExpired(a, today, days))
    .sort((a, b) => a.appoint_date.localeCompare(b.appoint_date)).slice(0, limit);
  const ids = new Set(victims.map((v) => v.id));
  for (const v of victims) {
    bump(R.monthOf(v.appoint_date), "appointments_cancelled", "cancel_reason", v.cancel_reason_code ?? "none", 1);
    bump(R.monthOf(v.appoint_date), "appointments_cancelled", "purpose", v.purpose_text?.trim() || "none", 1);
  }
  const events = (t.appointment_events ?? []).filter((e) => ids.has(e.appointment_id)).length;
  t.appointment_events = (t.appointment_events ?? []).filter((e) => !ids.has(e.appointment_id));
  t.appointments = (t.appointments ?? []).filter((a) => !ids.has(a.id));
  const seriesIds = new Set(victims.map((v) => v.series_id).filter(Boolean));
  const before = (t.appointment_series ?? []).length;
  t.appointment_series = (t.appointment_series ?? []).filter((s) => !seriesIds.has(s.id) || t.appointments.some((a) => a.series_id === s.id));
  return { appointments: victims.length, events, series: before - t.appointment_series.length };
}

export function resetDb(tables) {
  state.tables = { suggestions: [], messages: [], settings: [], knowledge_items: [], ai_daily_usage: [], ...tables };
  state.matchExamples = [];
  state.matchKnowledge = [];
  state.files = {};
  state.authUsers = [];
  state.revoked = [];
  state.passwordChanges = [];
  state.updateUserError = null;
}

function bucket(name) {
  const files = (state.files[name] ??= new Map());
  return {
    async upload(path, data) { files.set(path, { data, created_at: new Date().toISOString() }); return { data: { path }, error: null }; },
    async download(path) {
      const f = files.get(path);
      return f ? { data: new Blob([f.data]), error: null } : { data: null, error: new Error("not found") };
    },
    async remove(paths) { paths.forEach((p) => files.delete(p)); return { data: [], error: null }; },
    async list(prefix) {
      const data = [...files.entries()]
        .filter(([p]) => p.startsWith(`${prefix}/`))
        .map(([p, f]) => ({ name: p.slice(prefix.length + 1), created_at: f.created_at }));
      return { data, error: null };
    },
    async createSignedUploadUrl(path) { return { data: { signedUrl: `https://storage.test/upload/${path}` }, error: null }; },
    async createSignedUrls(paths) {
      return { data: paths.map((path) => ({ path, signedUrl: `https://storage.test/signed/${name}/${path}` })), error: null };
    },
  };
}

/** เลียนแบบ trigger ใน migration 014, 015 ของจริงทดสอบแยกบน production */
function refreshQueue(conversationId) {
  const conv = state.tables.conversations?.find((c) => c.id === conversationId);
  if (!conv) return;
  // เหมือน migration 057: ข้อความระบบไม่นับ ยกเว้นข้อความที่ระบบนัดส่งถึงลูกค้า · ข้อความตอบรับ (no_reply_needed) ไม่นับเวลารอ
  const msgs = state.tables.messages.filter((m) => m.conversation_id === conversationId && !m.imported
    && (m.sender_type !== "system" || (m.direction === "out" && String(m.imported_sender_name ?? "").startsWith("ระบบนัด"))))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const latest = (dir) => [...msgs].reverse().find((m) => m.direction === dir && (dir === "out" || m.sender_type !== "system"))?.created_at ?? null;
  conv.last_direction = [...msgs].reverse().find((m) => !(m.direction === "in" && m.no_reply_needed))?.direction ?? null;
  conv.last_inbound_at = latest("in");
  const floor = Math.max(Date.parse(latest("out") ?? 0) || 0, Date.parse(conv.closed_at ?? 0) || 0);
  conv.waiting_since = msgs.find((m) => m.direction === "in" && !m.no_reply_needed && Date.parse(m.created_at) > floor)?.created_at ?? null;
}

function trackStatus(conv, before) {
  if (conv.status === "closed" && before !== "closed") conv.closed_at = state.clock();
  if (conv.status === "open" && before === "closed") {
    conv.reopened_at = state.clock();
    conv.waiting_since = conv.last_direction === "in" ? conv.last_inbound_at : null;
  }
}
state.clock = nextTime;

function withRelations(name, row) {
  if (name !== "conversations") return row;
  return {
    ...row,
    channels: state.tables.channels?.find((c) => c.id === row.channel_id),
    contacts: state.tables.contacts?.find((c) => c.id === row.contact_id),
  };
}

/** เลียนแบบ trigger chat_tasks_refresh_open ใน migration 035 */
function refreshOpenTasks() {
  for (const conv of state.tables.conversations ?? []) {
    conv.open_tasks = (state.tables.chat_tasks ?? []).filter((t) => t.conversation_id === conv.id && !t.done).length;
  }
}

function refreshBookingPending() {
  for (const conv of state.tables.conversations ?? []) {
    conv.booking_pending = (state.tables.bookings ?? []).some((b) => b.conversation_id === conv.id && b.status === "ai_confirmed");
  }
}

function query(name) {
  const filters = [];
  let op = "select", payload = null, conflict = null, sort = null, max = Infinity;
  const sorts = [];
  const rows = () => {
    const table = (state.tables[name] ??= []);
    let out = table.filter((r) => filters.every((f) => f(r)));
    if (sorts.length > 1) {
      const cmp = (x, y) => {
        const dx = Date.parse(x), dy = Date.parse(y);
        if (!Number.isNaN(dx) && !Number.isNaN(dy)) return dx - dy;
        return String(x ?? "").localeCompare(String(y ?? ""));
      };
      out = [...out].sort((a, b) => { for (const o of sorts) { const c = cmp(a[o.key], b[o.key]) * o.dir; if (c) return c; } return 0; });
    } else if (sort) out = [...out].sort((a, b) => (Date.parse(a[sort.key]) - Date.parse(b[sort.key])) * sort.dir);
    return out.slice(0, max);
  };
  const run = () => {
    const table = (state.tables[name] ??= []);
    // upsert หลายแถวพร้อม ignoreDuplicates: คืนเฉพาะแถวใหม่ เหมือน PostgREST
    if (op === "upsert" && Array.isArray(payload)) {
      const added = [];
      for (const item of payload) {
        if (table.some((r) => r[conflict] === item[conflict])) continue;
        const row = { id: `${name}-${++seq}`, created_at: nextTime(), ...item };
        table.push(row);
        added.push(row);
      }
      return added;
    }
    if (op === "insert" || op === "upsert") {
      const keys = conflict?.split(",");
      const found = keys && table.find((r) => keys.every((k) => r[k] === payload[k]));
      if (found) { Object.assign(found, payload); return [found]; }
      const row = { id: `${name}-${++seq}`, created_at: nextTime(), ...payload };
      table.push(row);
      if (name === "messages") refreshQueue(row.conversation_id);
      if (name === "bookings") refreshBookingPending();
      if (name === "chat_tasks") refreshOpenTasks();
      return [row];
    }
    const hit = rows();
    if (op === "update") {
      hit.forEach((r) => {
        const before = r.status;
        Object.assign(r, payload);
        if (name === "conversations") trackStatus(r, before);
      });
      if (name === "bookings") refreshBookingPending();
      if (name === "chat_tasks") refreshOpenTasks();
    }
    if (op === "delete") {
      state.tables[name] = table.filter((r) => !hit.includes(r));
      if (name === "chat_tasks") refreshOpenTasks();
      if (name === "messages") hit.forEach((r) => refreshQueue(r.conversation_id));
    }
    return hit.map((r) => withRelations(name, r));
  };
  const b = {
    select() { return b; },
    insert(p) { op = "insert"; payload = p; return b; },
    upsert(p, o) { op = "upsert"; payload = p; conflict = o?.onConflict; return b; },
    update(p) { op = "update"; payload = p; return b; },
    delete() { op = "delete"; return b; },
    not(k, op, v) {
      if (op === "ov") {
        const list = v.replace(/[{}]/g, "").split(",");
        filters.push((r) => !(r[k] ?? []).some((x) => list.includes(x)));
      } else {
        filters.push((r) => (r[k] ?? null) !== v);
      }
      return b;
    },
    // รองรับเฉพาะรูปแบบ "col.is.null,col.lt.value" ที่โค้ดใช้
    or(expr) {
      const parts = expr.split(",").map((p) => {
        const [col, op, ...rest] = p.split(".");
        return { col, op, value: rest.join(".") };
      });
      filters.push((r) => parts.some(({ col, op, value }) =>
        op === "is" ? (r[col] ?? null) === null : r[col] != null && Date.parse(r[col]) < Date.parse(value)));
      return b;
    },
    eq(k, v) { filters.push((r) => r[k] === v); return b; },
    neq(k, v) { filters.push((r) => r[k] !== v); return b; },
    is(k, v) { filters.push((r) => (r[k] ?? null) === v); return b; },
    in(k, v) { filters.push((r) => v.includes(r[k])); return b; },
    lte(k, v) { filters.push((r) => r[k] != null && Date.parse(r[k]) <= Date.parse(v)); return b; },
    lt(k, v) { filters.push((r) => (typeof v === "number" ? (r[k] ?? 0) < v : Date.parse(r[k]) < Date.parse(v))); return b; },
    gte(k, v) { filters.push((r) => r[k] != null && r[k] >= v); return b; },
    like(k, v) { const prefix = v.replace(/%$/, ""); filters.push((r) => String(r[k]).startsWith(prefix)); return b; },
    order(key, o) { sort = { key, dir: o?.ascending === false ? -1 : 1 }; sorts.push(sort); return b; },
    limit(n) { max = n; return b; },
    range(a, z) { max = z - a + 1; return b; },
    async single() { return { data: run()[0] ?? null, error: null }; },
    async maybeSingle() { return { data: run()[0] ?? null, error: null }; },
    then(resolve) { const data = run(); return resolve({ data, error: null, count: data.length }); },
  };
  return b;
}

/** เลียนแบบ set_conversation_tag ใน migration 010 */
function setTag({ p_conversation, p_tag, p_action, p_by }) {
  const conv = state.tables.conversations.find((c) => c.id === p_conversation);
  const events = (state.tables.tag_events ??= []);
  conv.tags ??= [];
  const log = () => events.push({ conversation_id: p_conversation, tag: p_tag, action: p_action, by: p_by });
  if (p_action === "add") {
    const removedByStaff = events.some((e) => e.conversation_id === p_conversation && e.tag === p_tag && e.action === "remove" && e.by === "staff");
    if ((p_by === "staff" || !removedByStaff) && !conv.tags.includes(p_tag)) { conv.tags.push(p_tag); log(); }
  } else if (conv.tags.includes(p_tag)) {
    conv.tags = conv.tags.filter((t) => t !== p_tag);
    log();
  }
  return conv.tags;
}

/** เลียนแบบ set_assignee และ assign_if_unassigned ใน migration 019 */
function setAssignee(fn, { p_conversation, p_to, p_by }) {
  const conv = state.tables.conversations.find((c) => c.id === p_conversation);
  const log = (state.tables.assignment_log ??= []);
  const from = conv.assigned_to ?? null;
  if (fn === "assign_if_unassigned" && from) return from;
  if (from !== (p_to ?? null)) {
    conv.assigned_to = p_to;
    log.push({ conversation_id: p_conversation, from_staff: from, to_staff: p_to, by_staff: p_by ?? p_to });
  }
  return p_to;
}

const authAdmin = {
  async createUser({ email, password }) {
    if (state.authUsers.some((u) => u.email === email)) return { data: {}, error: { code: "email_exists" } };
    const user = { id: `user-${state.authUsers.length + 1}`, email, password };
    state.authUsers.push(user);
    return { data: { user }, error: null };
  },
  async updateUserById(id, patch) {
    let user = state.authUsers.find((u) => u.id === id);
    if (!user) state.authUsers.push((user = { id }));
    Object.assign(user, patch);
    return { data: { user }, error: null };
  },
  async deleteUser(id) { state.authUsers = state.authUsers.filter((u) => u.id !== id); return { error: null }; },
  async listUsers() { return { data: { users: state.authUsers } }; },
};

const client = {
  from: query,
  auth: { admin: authAdmin },
  storage: { from: bucket },
  async rpc(fn, args) {
    if (fn === "set_conversation_tag") return { data: setTag(args), error: null };
    if (fn === "set_assignee" || fn === "assign_if_unassigned") return { data: setAssignee(fn, args), error: null };
    if (fn === "revoke_staff_sessions") { state.revoked.push(args.p_user); return { error: null }; }
    if (fn === "retention_delete_tasks" || fn === "retention_delete_appointments") return { data: retentionDelete(fn, args.p_limit), error: null };
    if (fn === "touch_providers") {
      // เหมือนฟังก์ชันในฐานข้อมูล: ยุบช่องว่าง รวมชื่อซ้ำ (ไม่สนตัวพิมพ์) เก็บเวลาล่าสุด
      const list = (state.tables.providers ??= []);
      const seen = args.p_seen ?? new Date().toISOString();
      for (const raw of args.p_names) {
        const name = String(raw).replace(/\s+/g, " ").trim();
        if (!name) continue;
        const cur = list.find((p) => p.name.toLowerCase() === name.toLowerCase());
        if (cur) cur.last_seen_at = cur.last_seen_at > seen ? cur.last_seen_at : seen;
        else list.push({ name, last_seen_at: seen, active: null });
      }
      return { error: null };
    }
    if (fn === "match_examples") return { data: state.matchExamples };
    if (fn === "match_knowledge") return { data: state.matchKnowledge };
    if (fn === "line_send_summary") {
      const groups = new Map();
      for (const r of state.tables.line_sends ?? []) {
        if (Date.parse(r.created_at) < Date.parse(args.p_from)) continue;
        const k = [r.mode, r.kind, r.ok, r.fallback].join("|");
        const g = groups.get(k) ?? { mode: r.mode, kind: r.kind, ok: r.ok, fallback: r.fallback, requests: 0, messages: 0 };
        g.requests++; g.messages += r.message_count;
        groups.set(k, g);
      }
      return { data: [...groups.values()], error: null };
    }
    return { data: null };
  },
};
export const supabaseAdmin = () => client;
