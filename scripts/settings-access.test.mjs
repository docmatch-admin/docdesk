// สิทธิ์หน้าตั้งค่า (admin / agent / ห้องยา) · ตั้งค่าส่วนตัว · ประวัติการแก้ · ธีมสี: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { resetDb, state } = await import(fake("admin"));
const access = await import("../src/lib/settings-access.ts");
const theme = await import("../src/lib/theme.ts");
const audit = await import("../src/lib/settings-audit.ts");
const tagColors = await import("../src/lib/tag-colors.ts");
const { TAG_NAME_LOCKED } = await import("../src/lib/tags.ts");
const { CLEARED_ON_REOPEN_TAG, AUTO_CLOSE_EXEMPT_TAGS } = await import("../src/lib/case-flow.ts");
const { SENSITIVE_TAG } = await import("../src/lib/sensitive-rules.ts");
const { sendPushToStaff } = await import("../src/lib/booking-store.ts");

const aiModels = await import("../src/app/api/ai-models/route.ts");
const lineQuota = await import("../src/app/api/appointments/line-quota/route.ts");
const testSend = await import("../src/app/api/appointments/test-send/route.ts");
const knowledgeSync = await import("../src/app/api/knowledge/sync/route.ts");
const iserviceCheck = await import("../src/app/api/appointments/iservice-check/route.ts");
const lineUsage = await import("../src/app/api/line/usage/route.ts");
const prefsApi = await import("../src/app/api/preferences/route.ts");

const ADMIN = { id: "admin-1", email: "a@test" };
const AGENT = { id: "agent-1", email: "b@test" };
const PHARM = { id: "pharm-1", email: "p@test" };

beforeEach(() => {
  resetDb({
    staff: [
      { id: ADMIN.id, role: "admin", active: true, display_name: "แอดมิน" },
      { id: AGENT.id, role: "agent", active: true, display_name: "เอเจนต์" },
      { id: PHARM.id, role: "pharmacy", active: true, display_name: "ห้องยา" },
    ],
    settings: [],
    user_preferences: [],
    settings_audit: [],
    push_subscriptions: [],
  });
  state.currentUser = AGENT;
});

const req = (method, body) => new Request("https://app.test/api/x", {
  method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
});

// ---------------------------------------------------------------------------
// 1) สิทธิ์ตามหมวด
test("agent: แก้ได้ / เห็นอย่างเดียว / ไม่เห็น ตามสเปก · admin แก้ได้ทุกอย่าง · ห้องยาไม่มีหน้าตั้งค่า", () => {
  const edit = ["purposes", "closures", "seriesTemplates", "providers", "tags", "tagRules", "display"];
  const view = ["apptContact", "apptMessaging", "apptTemplate", "bookingTemplates", "clinicHours", "businessHours", "lineQuota", "health", "autoClose"];
  const hidden = ["aiModels", "aiMode", "channels", "persona", "sensitive", "scoring", "retention", "aiUsage", "priceAlerts", "audit", "testSend"];
  for (const a of edit) assert.equal(access.areaAccess("agent", a), "edit", a);
  for (const a of view) assert.equal(access.areaAccess("agent", a), "view", a);
  for (const a of hidden) assert.equal(access.areaAccess("agent", a), null, a);
  const all = Object.values(access.SECTION_AREAS).flat();
  assert.equal(new Set([...edit, ...view, ...hidden]).size, all.length, "ทุกส่วนถูกกำหนดสิทธิ์ของ agent");
  for (const a of all) {
    assert.equal(access.areaAccess("admin", a), "edit", `admin ${a}`);
    assert.equal(access.areaAccess("pharmacy", a), null, `pharmacy ${a}`);
  }
  assert.deepEqual(access.visibleSections("agent"), ["overview", "chat", "appointments", "display"]);
  assert.deepEqual(access.visibleSections("admin"), ["overview", "ai", "chat", "appointments", "team", "display"]);
  assert.deepEqual(access.visibleSections("pharmacy"), []);
  assert.equal(access.canOpenSettings("agent"), true);
  assert.equal(access.canOpenSettings("pharmacy"), false);
});

test("หน้าตั้งค่าและเมนู: agent เข้าได้ ชื่อเมนู ตั้งค่า · เมนูหมวดย่อยแสดงเฉพาะที่เห็น · ส่วนอ่านอย่างเดียวมีกุญแจ เฉพาะ admin", () => {
  const page = readFileSync("src/app/(staff)/settings/page.tsx", "utf8");
  assert.match(page, /canOpenSettings\(me\.role\)/);
  assert.match(page, /<SettingsClient role=\{me\.role\} \/>/);
  const layout = readFileSync("src/app/(staff)/layout.tsx", "utf8");
  assert.match(layout, /\{canOpenSettings\(me\.role\) && <Link href="\/settings" title="ตั้งค่า">/);
  assert.match(layout, /<span className="nav-label">ตั้งค่า<\/span>/);
  assert.doesNotMatch(layout, /ตั้งค่า AI/);
  const client = readFileSync("src/app/(staff)/settings/settings-client.tsx", "utf8");
  assert.match(client, /const tabs = TABS\.filter\(\(\[k\]\) => sections\.includes\(k\)\)/);
  assert.match(client, /\{tabs\.map\(\(\[k, label\]\) =>/);
  assert.match(client, /!sections\.includes\(t\) \? null/, "หมวดที่ไม่มีสิทธิ์ไม่ render");
  assert.match(client, /if \(coreDirty && isAdmin\)/);
  const save = readFileSync("src/app/(staff)/settings/settings-save.tsx", "utf8");
  assert.match(save, /if \(area && !access\) return null;/);
  assert.match(save, /<fieldset disabled className="set-locked">/);
  assert.match(save, /เฉพาะ admin/);
  // ทุกกลุ่มในหน้าตั้งค่าระบุ area
  for (const f of ["settings-client.tsx", "appointment-settings.tsx", "appointment-presets.tsx", "tag-settings.tsx", "health-panel.tsx", "line-usage-panel.tsx", "ai-models-panel.tsx", "series-templates.tsx", "provider-settings.tsx", "audit-log.tsx"]) {
    const src = readFileSync(`src/app/(staff)/settings/${f}`, "utf8");
    const groups = src.match(/<SetGroup [^>]*/g) ?? [];
    for (const g of groups) assert.match(g, /area="/, `${f}: ${g.slice(0, 60)}`);
  }
});

// ---------------------------------------------------------------------------
// 2) บังคับสิทธิ์ฝั่ง server
const ADMIN_ENDPOINTS = [
  ["GET /api/ai-models", () => aiModels.GET()],
  ["PUT /api/ai-models", () => aiModels.PUT(req("PUT", { chat: "gpt-4o-mini" }))],
  ["GET /api/appointments/line-quota", () => lineQuota.GET()],
  ["POST /api/appointments/test-send", () => testSend.POST(req("POST", { conversation_id: "c1" }))],
  ["POST /api/knowledge/sync", () => knowledgeSync.POST(req("POST", {}))],
  ["PATCH /api/knowledge/sync", () => knowledgeSync.PATCH()],
  ["GET /api/appointments/iservice-check", () => iserviceCheck.GET(new Request("https://app.test/api/appointments/iservice-check"))],
];
for (const [name, call] of ADMIN_ENDPOINTS) {
  test(`agent เรียก ${name}: 403`, async () => { assert.equal((await call()).status, 403); });
  test(`ห้องยาเรียก ${name}: 403`, async () => { state.currentUser = PHARM; assert.equal((await call()).status, 403); });
  test(`ไม่ได้ล็อกอินเรียก ${name}: 401`, async () => { state.currentUser = null; assert.equal((await call()).status, 401); });
}
test("โควตา LINE: agent ดูได้ (อ่านอย่างเดียว) ห้องยา 403 ไม่ได้ล็อกอิน 401", async () => {
  state.currentUser = PHARM;
  assert.equal((await lineUsage.GET()).status, 403);
  state.currentUser = null;
  assert.equal((await lineUsage.GET()).status, 401);
  const src = readFileSync("src/app/api/line/usage/route.ts", "utf8");
  assert.match(src, /await requireStaff\(\)/);
});

test("RLS (migration 054): agent แก้ได้เฉพาะตารางที่เปิดให้ เวลาเปิดคลินิกเฉพาะ admin · settings อ่านได้เฉพาะคีย์ที่จำเป็น", () => {
  const sql = readFileSync("supabase/migrations/054_settings_roles_audit_prefs.sql", "utf8");
  assert.match(sql, /role in \('admin', 'agent'\)/);
  const editable = sql.match(/foreach t in array array\[([^\]]+)\] loop\s+execute format\('drop policy if exists admin_write/)[1];
  for (const t of ["tags", "tag_rules", "appointment_purposes", "clinic_closures", "appointment_series_templates", "providers"]) assert.ok(editable.includes(`'${t}'`), t);
  assert.ok(!editable.includes("clinic_hours"), "เวลาเปิดคลินิกยังแก้ได้เฉพาะ admin");
  assert.ok(!editable.includes("'settings'"), "ตาราง settings แก้ได้เฉพาะ admin");
  const agentKeys = sql.match(/key in \(([^)]+)\)/)[1];
  for (const k of ["ai_models", "clinic_profile", "sensitive_keywords", "score_rules", "media_retention_days", "sensitive_media_retention_days"]) assert.ok(!agentKeys.includes(`'${k}'`), `agent อ่าน ${k} ไม่ได้`);
  assert.match(sql, /create policy admin_read on settings_audit for select to authenticated using \(is_admin\(\)\)/);
  assert.doesNotMatch(sql, /policy [a-z_]+ on settings_audit for (insert|all)/, "เขียนได้ผ่าน trigger เท่านั้น");
  assert.match(sql, /using \(user_id = auth\.uid\(\)/, "ตั้งค่าส่วนตัวแก้ได้เฉพาะของตัวเอง");
  // rename_tag: เฉพาะคนที่แก้แท็กได้ · แท็กที่โค้ดใช้ตามชื่อเปลี่ยนไม่ได้ (ตรงกับรายการในโค้ด)
  assert.match(sql, /if not is_settings_editor\(\) then raise exception 'forbidden'/);
  const locked = sql.match(/if v_old in \(([^)]+)\) then raise exception/)[1].split(",").map((s) => s.trim().replace(/'/g, ""));
  assert.deepEqual([...locked].sort(), [...TAG_NAME_LOCKED].sort());
  assert.deepEqual([...TAG_NAME_LOCKED].sort(), [CLEARED_ON_REOPEN_TAG, ...AUTO_CLOSE_EXEMPT_TAGS, SENSITIVE_TAG].sort());
  for (const t of ["conversations set tags = array_replace", "suggestions set suggested_tags = array_replace", "tag_rules set tag", "tag_events set tag"]) assert.ok(sql.includes(t), t);
});

// ---------------------------------------------------------------------------
// 3) ประวัติการแก้ตั้งค่า
test("ประวัติ: trigger ทุกตารางตั้งค่า บันทึกใคร/หมวด/ค่าเก่า-ใหม่ · การแก้ผ่าน server บันทึกพร้อมชื่อผู้แก้", async () => {
  const sql = readFileSync("supabase/migrations/054_settings_roles_audit_prefs.sql", "utf8");
  const tables = sql.match(/array\['settings', 'channels'[^\]]+\]/)[0];
  for (const t of ["settings", "channels", "tags", "tag_rules", "appointment_purposes", "clinic_hours", "clinic_closures", "appointment_series_templates", "providers"]) assert.ok(tables.includes(`'${t}'`), t);
  assert.match(sql, /insert into settings_audit \(actor_id, actor_name, section, table_name, record_key, action, old_value, new_value\)/);
  // AI models เขียนด้วย service role → บันทึกเองพร้อมผู้แก้
  state.currentUser = ADMIN;
  const res = await aiModels.PUT(req("PUT", { chat: "gpt-4.1-mini" }));
  assert.equal(res.status, 200);
  const row = state.tables.settings_audit.at(-1);
  assert.equal(row.actor_id, ADMIN.id);
  assert.equal(row.actor_name, "แอดมิน");
  assert.equal(row.section, "AI");
  assert.equal(row.new_value.value.chat, "gpt-4.1-mini");
  const changes = audit.auditChanges(row);
  assert.deepEqual(changes.map((c) => c.field), ["chat"]);
  // แก้ค่าเดิมซ้ำไม่บันทึกซ้ำ
  await aiModels.PUT(req("PUT", { chat: "gpt-4.1-mini" }));
  assert.equal(state.tables.settings_audit.length, 1);
});

test("ประวัติ: สรุปค่าเก่า→ใหม่ ข้ามคอลัมน์ที่เปลี่ยนเอง เพิ่ม/ลบ แสดงฝั่งเดียว", () => {
  assert.deepEqual(audit.auditChanges({ table_name: "tags", old_value: { id: "1", name: "วัคซีน", color: "#111111", updated_at: "a" }, new_value: { id: "1", name: "วัคซีน", color: "#222222", updated_at: "b" } }),
    [{ field: "color", from: "#111111", to: "#222222" }]);
  assert.deepEqual(audit.auditChanges({ table_name: "settings", old_value: { key: "auto_close_hours", value: 24 }, new_value: { key: "auto_close_hours", value: 48 } }),
    [{ field: "ค่า", from: "24", to: "48" }]);
  assert.deepEqual(audit.auditChanges({ table_name: "clinic_closures", old_value: null, new_value: { closed_on: "2026-12-31", reason: "สิ้นปี" } }).map((c) => c.from), ["–", "–"]);
  const admin = readFileSync("src/app/(staff)/settings/audit-log.tsx", "utf8");
  assert.match(admin, /area="audit"/);
  assert.equal(access.areaAccess("agent", "audit"), null);
});

// ---------------------------------------------------------------------------
// 4) ตั้งค่าส่วนตัวต่อผู้ใช้ (sync ทุกเครื่อง)
test("ตั้งค่าส่วนตัว: แก้ได้เฉพาะของตัวเอง รับเฉพาะคีย์ที่รู้จัก ตั้ง cookie ให้ server วาดหน้าถูกตั้งแต่แรก", async () => {
  const get = await prefsApi.GET();
  assert.deepEqual(await get.json(), theme.DEFAULT_PREFERENCES);
  const res = await prefsApi.PUT(req("PUT", { theme: "dark", sound_muted: true, font_size: "large", user_id: ADMIN.id, role: "admin" }));
  assert.equal(res.status, 200);
  assert.deepEqual(state.tables.user_preferences.map((r) => r.user_id), [AGENT.id], "แก้ได้เฉพาะแถวของตัวเอง");
  const saved = state.tables.user_preferences[0];
  assert.equal(saved.theme, "dark");
  assert.equal(saved.sound_muted, true);
  assert.equal(saved.font_size, "large");
  const cookies = res.headers.getSetCookie().join(";");
  assert.match(cookies, /dd_theme=dark/);
  assert.match(cookies, /dd_font=large/);
  assert.equal((await prefsApi.PUT(req("PUT", { evil: 1 }))).status, 400);
  // ค่าแปลก ๆ ถูกปรับเป็นค่าที่ใช้ได้
  await prefsApi.PUT(req("PUT", { theme: "neon" }));
  assert.equal(state.tables.user_preferences[0].theme, "system");
  state.currentUser = null;
  assert.equal((await prefsApi.PUT(req("PUT", { theme: "dark" }))).status, 401);
  // ห้องยาก็มีตั้งค่าส่วนตัว
  state.currentUser = PHARM;
  assert.equal((await prefsApi.PUT(req("PUT", { sound_muted: true }))).status, 200);
});

test("ตั้งค่าส่วนตัว: เสียง/ย่อเมนู/แจ้งเตือนในเมนูซ้ายใช้ค่าเดียวกัน sync realtime (ไม่ใช้ localStorage)", () => {
  const provider = readFileSync("src/app/(staff)/preferences.tsx", "utf8");
  assert.match(provider, /table: "user_preferences", filter: `user_id=eq\.\$\{userId\}`/);
  assert.match(provider, /fetch\("\/api\/preferences", \{ method: "PUT"/);
  const alertSrc = readFileSync("src/app/(staff)/waiting-alert.tsx", "utf8");
  assert.match(alertSrc, /const muted = prefs\.sound_muted;/);
  assert.match(alertSrc, /update\(\{ sound_muted: !muted \}\)/);
  assert.doesNotMatch(alertSrc, /localStorage/);
  const nav = readFileSync("src/app/(staff)/nav-toggle.tsx", "utf8");
  assert.match(nav, /update\(\{ nav_collapsed: !collapsed \}\)/);
  assert.match(nav, /aria-label=\{collapsed \? "ขยายเมนู" : "ย่อเมนู"\}/);
  assert.doesNotMatch(nav, /localStorage/);
  const push = readFileSync("src/app/(staff)/push-toggle.tsx", "utf8");
  assert.match(push, /const on = subscribed && prefs\.push_enabled;/);
  const sql = readFileSync("supabase/migrations/054_settings_roles_audit_prefs.sql", "utf8");
  assert.match(sql, /alter publication supabase_realtime add table user_preferences/);
  const css = readFileSync("src/app/globals.css", "utf8");
  assert.match(css, /html\[data-nav="collapsed"\] \.nav \{ width: 68px;/);
  assert.match(css, /html\[data-font="large"\] body \{ font-size: 17px; \}/);
});

test("แจ้งเตือน: ผู้ใช้ที่ปิดแจ้งเตือน ไม่ได้รับทุกเครื่อง", async () => {
  state.tables.push_subscriptions = [
    { endpoint: "https://push/a", staff_id: ADMIN.id, p256dh: "k", auth: "a" },
    { endpoint: "https://push/b", staff_id: AGENT.id, p256dh: "k", auth: "a" },
    { endpoint: "https://push/c", staff_id: AGENT.id, p256dh: "k", auth: "a" },
  ];
  state.tables.user_preferences = [{ user_id: AGENT.id, push_enabled: false }];
  const sent = [];
  const n = await sendPushToStaff(null, { title: "t", body: "b", url: "/" }, async (sub) => { sent.push(sub.endpoint); });
  assert.equal(n, 1);
  assert.deepEqual(sent, ["https://push/a"]);
});

test("ธีม: cookie → แอตทริบิวต์ <html> ฝั่ง server (ไม่มีจอกะพริบ) ตามระบบ = ไม่ใส่ data-theme", () => {
  const jar = { dd_theme: "dark", dd_font: "large", dd_nav: "collapsed" };
  assert.deepEqual(theme.htmlAttrs((k) => jar[k]), { "data-theme": "dark", "data-font": "large", "data-nav": "collapsed" });
  assert.deepEqual(theme.htmlAttrs(() => undefined), {});
  assert.deepEqual(theme.htmlAttrs((k) => (k === "dd_theme" ? "system" : undefined)), {});
  assert.deepEqual(theme.normalizePreferences({ theme: "x", push_enabled: "no", sound_muted: 1 }), { ...theme.DEFAULT_PREFERENCES });
  assert.equal(theme.effectiveTheme("system", true), "dark");
  assert.equal(theme.effectiveTheme("light", true), "light");
  // ใช้ค่าทันที + เขียน cookie
  const root = { dataset: {} };
  const doc = { documentElement: root, cookie: "" };
  const cookies = [];
  Object.defineProperty(doc, "cookie", { set: (v) => cookies.push(v), get: () => cookies.join("; ") });
  theme.applyPreferences({ ...theme.DEFAULT_PREFERENCES, theme: "dark", nav_collapsed: true }, doc);
  assert.equal(root.dataset.theme, "dark");
  assert.equal(root.dataset.nav, "collapsed");
  assert.ok(cookies.some((c) => c.startsWith("dd_theme=dark")));
  theme.applyPreferences(theme.DEFAULT_PREFERENCES, doc);
  assert.equal(root.dataset.theme, undefined);
  const layout = readFileSync("src/app/layout.tsx", "utf8");
  assert.match(layout, /const jar = await cookies\(\);/);
  assert.match(layout, /<html lang="th" suppressHydrationWarning \{\.\.\.attrs\}>/);
  assert.doesNotMatch(layout, /localStorage/);
  const quick = readFileSync("src/app/(staff)/preferences.tsx", "utf8");
  assert.match(quick, /export function ThemeQuickToggle/);
  assert.match(quick, /name=\{dark \? "sun" : "moon"\}/);
  assert.match(readFileSync("src/app/(staff)/layout.tsx", "utf8"), /<ThemeQuickToggle \/>/);
});

// ---------------------------------------------------------------------------
// 5) ธีมสี: token ชุดเดียว คอนทราสต์ ≥ 4.5:1 ไม่มีสีตายตัวในคอมโพเนนต์
const css = readFileSync("src/app/globals.css", "utf8");
function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) out[m[1]] = m[2];
  return out;
}
const lightBlock = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
const darkStart = css.indexOf(':root[data-theme="dark"] {');
const darkBlock = css.slice(darkStart, css.indexOf("}", darkStart));
const LIGHT = tokens(lightBlock);
const DARK = tokens(darkBlock);
const PAIRS = [
  ["ink", "bg"], ["ink", "card"], ["muted", "card"], ["muted", "bg"], ["muted-strong", "card"], ["muted-strong", "bg"], ["blue", "card"],
  ["on-accent", "accent-solid"], ["on-accent", "success-solid"], ["on-accent", "danger-solid"],
  ["success-ink", "success-soft"], ["warning-ink", "warning-soft"], ["danger-ink", "danger-soft"], ["info-ink", "info-soft"], ["blue-ink", "blue-soft"],
  ["purple-ink", "purple-soft"], ["ch-line-ink", "ch-line-soft"], ["ch-facebook-ink", "ch-facebook-soft"], ["ch-instagram-ink", "ch-instagram-soft"],
  ["on-accent", "ch-line"], ["on-accent", "ch-facebook"], ["on-accent", "ch-instagram"],
  ["bubble-in-ink", "bubble-in-bg"], ["bubble-out-ink", "bubble-out-bg"], ["bubble-ai-ink", "bubble-ai-bg"], ["bubble-note-ink", "bubble-note-bg"],
];
test("ธีม: คอนทราสต์ข้อความ ≥ 4.5:1 ทั้งโหมดสว่างและมืด (รวมข้อความสีจางในโหมดมืด)", () => {
  for (const [mode, t] of [["สว่าง", LIGHT], ["มืด", { ...LIGHT, ...DARK }]]) {
    for (const [fg, bg] of PAIRS) {
      assert.ok(t[fg] && t[bg], `${mode}: มี token ${fg}/${bg}`);
      const c = tagColors.contrast(t[fg], t[bg]);
      assert.ok(c >= 4.5, `${mode}: ${fg} ${t[fg]} บน ${bg} ${t[bg]} = ${c.toFixed(2)}`);
    }
  }
  // token ครบทุกกลุ่มทั้งสองโหมด
  for (const k of ["bg", "card", "line", "ink", "muted", "blue", "success", "warning", "danger", "info"]) {
    assert.ok(LIGHT[k], `สว่าง ${k}`);
    assert.ok(DARK[k], `มืด ${k}`);
  }
});

test("ธีม: bubble ลูกค้า/พนักงาน/AI/บันทึกภายใน แยกสีชัดทั้งสองโหมด", () => {
  for (const t of [LIGHT, { ...LIGHT, ...DARK }]) {
    const bgs = ["bubble-in-bg", "bubble-out-bg", "bubble-ai-bg", "bubble-note-bg"].map((k) => t[k]);
    assert.equal(new Set(bgs).size, 4);
  }
  assert.match(css, /\.msg\.in \.bubble \{ background: var\(--bubble-in-bg\); color: var\(--bubble-in-ink\);/);
  assert.match(css, /\.msg\.out \.bubble \{ background: var\(--bubble-out-bg\); color: var\(--bubble-out-ink\);/);
  assert.match(css, /\.msg\.out\.ai \.bubble \{ background: var\(--bubble-ai-bg\); color: var\(--bubble-ai-ink\); \}/);
  assert.match(css, /\.internal-notes \.note \{ background: var\(--bubble-note-bg\); \}/);
});

test("ธีม: ไม่มีสีตายตัวในคอมโพเนนต์ (ยกเว้นบล็อก token ใบนัด และ @media print)", () => {
  const lines = css.split(/\r?\n/);
  let skip = false, depth = 0;
  const bad = [];
  lines.forEach((l, i) => {
    if (/^:root|prefers-color-scheme: dark|data-theme="dark"|^\.appt-slip, \.print-slip|^@media print/.test(l)) skip = true;
    if (!skip && /#[0-9a-fA-F]{3,6}\b/.test(l) && !/appt-slip|print-slip/.test(l)) bad.push(`${i + 1}: ${l.trim().slice(0, 80)}`);
    if (skip) { depth += (l.match(/{/g) || []).length - (l.match(/}/g) || []).length; if (depth <= 0) { skip = false; depth = 0; } }
  });
  assert.deepEqual(bad, []);
  // ใบนัด/พิมพ์: ขาวดำเสมอ ไม่ตามธีม
  assert.match(css, /\.appt-slip, \.print-slip \{[^}]*--card: #fff;[^}]*color-scheme: light;/);
  assert.match(css, /@media print \{\n  :root, :root\[data-theme="dark"\] \{/);
});

test("ชิปแท็กโหมดมืด: พื้นเข้ม ตัวอักษรสว่างจากสีแท็ก อ่านได้ทุกสี รวมเหลืองอ่อน ม่วงสด ดำ ขาว", () => {
  for (const c of ["#fde047", "#fef08a", "#fff7ae", "#a855f7", "#7c3aed", "#d946ef", "#000000", "#ffffff", "#475569", "#dc2626", "#22a06b", "#0891b2", "#4a63e0"]) {
    const t = tagColors.tagChipColors(c);
    assert.ok(tagColors.contrast(t.darkInk, t.darkBg) >= 4.5, `${c}: ${t.darkInk} บน ${t.darkBg}`);
    assert.ok(tagColors.contrast(t.darkBg, "#ffffff") > 8, `${c}: พื้นชิปเข้ม`);
  }
  assert.equal(tagColors.tagChipColors("ไม่ใช่สี").color, "#475569");
  const chip = readFileSync("src/app/(staff)/tag-chip.tsx", "utf8");
  assert.match(chip, /style=\{tagChipStyle\(c\) as React\.CSSProperties\}/);
  assert.match(css, /:root\[data-theme="dark"\] \.tag-chip\[style\] \{ background: var\(--tag-dark-bg\); color: var\(--tag-dark-ink\);/);
});
