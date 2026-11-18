// วัดจำนวน request ของหน้าแชท (component จริงใน Chrome headless, จำลอง Supabase + API ให้ตอบช้า LATENCY ms)
// 3 สถานการณ์: เปิดหน้า · เปิดแชท 1 แชท · มีข้อความเข้า (แชทอื่น) — นับจนเงียบ QUIET ms
// ใช้: node scripts/e2e/inbox-perf.mjs   (หรือ import { measureInbox } จากเทส)
import { readFileSync } from "node:fs";
import { bundle, chromeAvailable, openPage } from "./browser.mjs";

export const LATENCY = 120;
const QUIET = 3000;

const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");

// ---------- Supabase จำลอง: นับทุก query / rpc / storage และ realtime ที่สั่งยิงได้ ----------
const SUPABASE_STUB = `
const LAT = window.__latency;
function log(kind, ms) { window.__req.push({ kind, at: performance.now(), ms }); }
function rowsOf(table) { return (window.__db[table] ||= []); }
function q(table) {
  const st = { table, op: "select", filters: [], order: null, limit: null, single: false, patch: null, head: false };
  const api = {
    select(_c, o) { if (o && o.head) st.head = true; return api; },
    eq(k, v) { st.filters.push((r) => r[k] === v); return api; },
    neq(k, v) { st.filters.push((r) => r[k] !== v); return api; },
    in(k, vs) { st.filters.push((r) => vs.includes(r[k])); return api; },
    is(k, v) { st.filters.push((r) => (r[k] ?? null) === v); return api; },
    not() { return api; }, or() { return api; }, gte() { return api; }, lte() { return api; }, lt() { return api; }, gt() { return api; },
    contains(k, vs) { st.filters.push((r) => vs.every((v) => (r[k] || []).includes(v))); return api; },
    order() { return api; }, range() { return api; },
    limit(n) { st.limit = n; return api; },
    maybeSingle() { st.single = true; return api; }, single() { st.single = true; return api; },
    update(p) { st.op = "update"; st.patch = p; return api; },
    insert(p) { st.op = "insert"; st.patch = p; return api; },
    upsert(p) { st.op = "insert"; st.patch = p; return api; },
    delete() { st.op = "delete"; return api; },
    then(res, rej) {
      const t0 = performance.now();
      return new Promise((r) => setTimeout(r, LAT)).then(() => {
        log("sb " + st.op + " " + table, performance.now() - t0);
        let rows = rowsOf(table).filter((r) => st.filters.every((f) => f(r)));
        if (st.op === "update") {
          rows.forEach((r) => Object.assign(r, st.patch));
          if (table === "conversations") rows.forEach((r) => window.__emit("conversations", "UPDATE", r));
          return { data: null, error: null };
        }
        if (st.op !== "select") return { data: null, error: null };
        const count = rows.length;
        if (st.limit != null) rows = rows.slice(0, st.limit);
        rows = rows.map((r) => JSON.parse(JSON.stringify(r)));
        return { data: st.single ? rows[0] ?? null : st.head ? null : rows, error: null, count };
      }).then(res, rej);
    },
  };
  return api;
}
const channels = [];
window.__emit = (table, event, row) => {
  const payload = { eventType: event, table, schema: "public", new: event === "DELETE" ? {} : JSON.parse(JSON.stringify(row)), old: { id: row.id } };
  setTimeout(() => { for (const ch of channels) for (const h of ch.handlers) if (h.table === table && (h.event === "*" || h.event === event)) h.cb(payload); }, 30);
};
const client = {
  from: (t) => q(t),
  rpc: (name) => ({ then(res, rej) { const t0 = performance.now(); return new Promise((r) => setTimeout(r, LAT)).then(() => { log("sb rpc " + name, performance.now() - t0); return { data: [], error: null }; }).then(res, rej); } }),
  storage: { from: () => ({ createSignedUrls: async () => { log("sb storage", LAT); return { data: [] }; } }) },
  channel(name) {
    const ch = { name, handlers: [], on(_t, f, cb) { this.handlers.push({ table: f.table, event: f.event, cb }); return this; }, subscribe(cb) { channels.push(this); if (cb) setTimeout(() => cb("SUBSCRIBED"), 10); return this; } };
    return ch;
  },
  removeChannel(ch) { const i = channels.indexOf(ch); if (i >= 0) channels.splice(i, 1); },
};
exports.supabaseBrowser = () => client;`;

const STUBS = {
  "@/lib/supabase/browser": SUPABASE_STUB,
  "next/navigation": `exports.useRouter = () => ({ push() {}, replace() {}, refresh() {} }); exports.usePathname = () => "/inbox"; exports.useSearchParams = () => new URLSearchParams();`,
  "next/link": `const { jsx } = require("react/jsx-runtime"); exports.default = function Link(p) { return jsx("a", { ...p, href: p.href }); }; exports.__esModule = true;`,
  "./preferences": `exports.usePreferences = () => ({ prefs: { sound_muted: true }, update() {} }); exports.usePreferencesOptional = () => null;`,
};

const ENTRY = `
import { createRoot } from "react-dom/client";
import { InboxClient } from "@/app/(staff)/inbox/inbox-client";
import { ChatBadge } from "@/app/(staff)/chat-badge";
import { WaitingAlert } from "@/app/(staff)/waiting-alert";
const me = { id: "me", role: "admin" as const, displayName: "ฉัน", canViewSensitive: true, sensitiveAcked: true };
const zero = { waiting: 0, work: 0, total: 0 };
createRoot(document.getElementById("root")!).render(<>
  <nav><ChatBadge initial={zero} /><WaitingAlert meId="me" /></nav>
  <InboxClient me={me} />
  <nav><ChatBadge initial={zero} channel="chat-badge-mobile" /></nav>
</>);
`;

// ---------- ข้อมูลตัวอย่าง: 30 แชท (10 รอตอบ · 10 ตอบแล้ว · 10 เสร็จ) ----------
const DATA = `
const now = Date.now();
const iso = (m) => new Date(now - m * 60000).toISOString();
const conv = (i, status, dir) => ({
  id: "c" + i, status, last_direction: dir, archived: false, sensitive: false, tags: [], unread_count: dir === "in" ? 1 : 0,
  waiting_since: dir === "in" ? iso(60 - i) : null, last_inbound_at: iso(60 - i), last_message_at: iso(60 - i), assigned_to: null,
  booking_pending: false, open_tasks: 0, ai_mode: null, ai_due_at: null, channel_id: "ch1",
  contacts: { display_name: "ลูกค้า " + i, avatar_url: null, language: "th", platform_name: null, hn: null, patient_full_name: null, name_source: null, patient_relation: null, name_locked: false },
  channels: { type: "line", name: "LINE", ai_mode: null },
});
window.__db = {
  conversations: [...Array(30)].map((_, i) => conv(i, i < 20 ? "open" : "closed", i < 10 ? "in" : "out")),
  messages: [...Array(40)].map((_, i) => ({ id: "m" + i, conversation_id: "c0", direction: i % 2 ? "out" : "in", body: "ข้อความ " + i, body_th: null, created_at: iso(120 - i), sender_type: i % 2 ? "staff" : "customer", imported: false })),
  tags: [], staff: [{ id: "me", display_name: "ฉัน", active: true, role: "admin" }], settings: [], quick_media: [], suggestions: [], bookings: [], assignment_log: [], chat_tasks: [], chat_notes: [],
};
window.__req = [];
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
window.fetch = async (input, init) => {
  const url = new URL(String(input), "http://app.test");
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, window.__latency));
  window.__req.push({ kind: "api " + (init?.method ?? "GET") + " " + url.pathname.replace(/c\\d+/, "{id}") + (url.search ? "?" + [...url.searchParams.keys()].join("&") : ""), at: performance.now(), ms: performance.now() - t0 });
  const p = url.pathname;
  const m = p.match(/^\\/api\\/conversations\\/([^/]+)\\/read$/);
  if (m) { const c = window.__db.conversations.find((x) => x.id === m[1]); if (c) { c.last_read_marked_at = new Date().toISOString(); window.__emit("conversations", "UPDATE", c); } return json({ result: "ok" }); }
  if (p === "/api/inbox/work") return json({ work: {}, counts: { waiting: 10, work: 0, total: 10 } });
  if (p === "/api/inbox/list") return window.__inboxList ? json(window.__inboxList(url)) : json({});
  if (/^\\/api\\/conversations\\/[^/]+$/.test(p)) return json({ conv: { sensitive: false, archived: false }, messages: window.__db.messages, bookings: [], suggestion: null, history: [], tasks: [], notes: [], tagSources: {}, archive: [], appointments: { groups: [] }, labResults: [] });
  if (p.endsWith("/appointments")) return json({ groups: [] });
  if (p.endsWith("/archive")) return json({ candidates: [] });
  if (p.endsWith("/tags")) return json({ sources: {} });
  if (p === "/api/lab-results") return json({ results: [] });
  return json({});
};
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(page, since) {
  // นับจนไม่มี request ใหม่นาน QUIET ms (เผื่อ debounce)
  let last = -1, stableFor = 0;
  for (;;) {
    await sleep(250);
    const n = await page.evaluate(`window.__req.length`);
    if (n === last) { stableFor += 250; if (stableFor >= QUIET) break; } else { stableFor = 0; last = n; }
  }
  const reqs = await page.evaluate(`window.__req.slice(${since})`);
  const start = await page.evaluate(`window.__t0`);
  const end = reqs.length ? Math.max(...reqs.map((r) => r.at)) : start;
  const byKind = {};
  for (const r of reqs) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  return { count: reqs.length, ms: Math.round(end - start), byKind };
}

export async function measureInbox() {
  const code = bundle(ENTRY, STUBS);
  const page = await openPage(`<!doctype html><html lang="th"><head><meta charset="utf-8"><style>${css}</style></head><body>
<div id="root"></div><script>window.__latency = ${LATENCY}; window.__t0 = performance.now();\n${DATA}</script><script>${code}</script></body></html>`);
  try {
    await page.waitFor(`document.querySelectorAll(".q-row").length > 0`);
    const openReady = await page.evaluate(`Math.round(performance.now() - window.__t0)`);
    const open = { ...(await settle(page, 0)), ready: openReady };

    let since = await page.evaluate(`window.__t0 = performance.now(); window.__req.length`);
    await page.click(`.q-row`);
    await page.waitFor(`document.querySelectorAll(".msg").length > 0`, 8000).catch(() => {});
    const chatReady = await page.evaluate(`Math.round(performance.now() - window.__t0)`);
    const chat = { ...(await settle(page, since)), ready: chatReady };

    // ข้อความเข้าแชทอื่น: messages INSERT + conversations UPDATE (เหมือน webhook)
    since = await page.evaluate(`(() => { window.__t0 = performance.now(); const c = window.__db.conversations.find((x) => x.id === "c15");
      Object.assign(c, { last_direction: "in", waiting_since: new Date().toISOString(), last_message_at: new Date().toISOString(), unread_count: 1 });
      window.__emit("messages", "INSERT", { id: "mx", conversation_id: "c15", direction: "in", body: "สวัสดี", created_at: new Date().toISOString() });
      window.__emit("conversations", "UPDATE", c);
      return window.__req.length; })()`);
    await page.waitFor(`[...document.querySelectorAll(".q-section.waiting .q-row")].some((r) => r.textContent.includes("ลูกค้า 15"))`, 8000).catch(() => {});
    const inReady = await page.evaluate(`Math.round(performance.now() - window.__t0)`);
    const incoming = { ...(await settle(page, since)), ready: inReady };
    const errors = page.logs.filter((l) => l.startsWith("EXCEPTION"));
    return { open, chat, incoming, errors };
  } finally {
    page.close();
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("inbox-perf.mjs")) {
  if (!chromeAvailable()) { console.log("ไม่พบ Chrome"); process.exit(0); }
  const r = await measureInbox();
  for (const [k, v] of Object.entries({ "เปิดหน้า": r.open, "เปิดแชท": r.chat, "ข้อความเข้า": r.incoming })) {
    console.log(`${k}: ${v.count} request · หน้าจอพร้อม ${v.ready} ms · request สุดท้าย ${v.ms} ms`);
    for (const [kind, n] of Object.entries(v.byKind).sort()) console.log(`   ${n} × ${kind}`);
  }
  if (r.errors.length) console.log(r.errors.join("\n"));
}
