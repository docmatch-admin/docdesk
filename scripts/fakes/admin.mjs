// แทน src/lib/supabase/admin.ts ในเทสต์: ฐานข้อมูลในหน่วยความจำ
let seq = 0;
let clock = Date.parse("2026-11-01T03:00:00Z");
export const state = { tables: {}, matchExamples: [], matchKnowledge: [], files: {} };

export function nextTime() { clock += 1000; return new Date(clock).toISOString(); }
export function resetDb(tables) {
  state.tables = { suggestions: [], messages: [], settings: [], knowledge_items: [], ai_daily_usage: [], ...tables };
  state.matchExamples = [];
  state.matchKnowledge = [];
  state.files = {};
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
  const msgs = state.tables.messages.filter((m) => m.conversation_id === conversationId)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const latest = (dir) => [...msgs].reverse().find((m) => m.direction === dir)?.created_at ?? null;
  conv.last_direction = msgs.at(-1)?.direction ?? null;
  conv.last_inbound_at = latest("in");
  const floor = Math.max(Date.parse(latest("out") ?? 0) || 0, Date.parse(conv.closed_at ?? 0) || 0);
  conv.waiting_since = msgs.find((m) => m.direction === "in" && Date.parse(m.created_at) > floor)?.created_at ?? null;
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

function query(name) {
  const filters = [];
  let op = "select", payload = null, conflict = null, sort = null, max = Infinity;
  const rows = () => {
    const table = (state.tables[name] ??= []);
    let out = table.filter((r) => filters.every((f) => f(r)));
    if (sort) out = [...out].sort((a, b) => (Date.parse(a[sort.key]) - Date.parse(b[sort.key])) * sort.dir);
    return out.slice(0, max);
  };
  const run = () => {
    const table = (state.tables[name] ??= []);
    if (op === "insert" || op === "upsert") {
      const keys = conflict?.split(",");
      const found = keys && table.find((r) => keys.every((k) => r[k] === payload[k]));
      if (found) { Object.assign(found, payload); return [found]; }
      const row = { id: `${name}-${++seq}`, created_at: nextTime(), ...payload };
      table.push(row);
      if (name === "messages") refreshQueue(row.conversation_id);
      return [row];
    }
    const hit = rows();
    if (op === "update") {
      hit.forEach((r) => {
        const before = r.status;
        Object.assign(r, payload);
        if (name === "conversations") trackStatus(r, before);
      });
    }
    if (op === "delete") {
      state.tables[name] = table.filter((r) => !hit.includes(r));
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
    lt(k, v) { filters.push((r) => Date.parse(r[k]) < Date.parse(v)); return b; },
    order(key, o) { sort = { key, dir: o?.ascending === false ? -1 : 1 }; return b; },
    limit(n) { max = n; return b; },
    async single() { return { data: run()[0] ?? null, error: null }; },
    async maybeSingle() { return { data: run()[0] ?? null, error: null }; },
    then(resolve) { return resolve({ data: run(), error: null }); },
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

const client = {
  from: query,
  storage: { from: bucket },
  async rpc(fn, args) {
    if (fn === "set_conversation_tag") return { data: setTag(args), error: null };
    if (fn === "match_examples") return { data: state.matchExamples };
    if (fn === "match_knowledge") return { data: state.matchKnowledge };
    return { data: null };
  },
};
export const supabaseAdmin = () => client;
