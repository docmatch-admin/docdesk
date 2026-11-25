// ผลแล็บจาก Bangkok Medical Lab: sync → PDF ใน Storage → จับคู่ HN → แจ้งคนไข้ LINE / แจ้งทีม → คนไข้เปิดผ่าน LIFF: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-token";

const { nextTime, resetDb, state } = await import(fake("admin"));
const rules = await import("../src/lib/lab-results-rules.ts");
const store = await import("../src/lib/lab-results-store.ts");
const bml = await import("../src/lib/bml-client.ts");
const cronRoute = await import("../src/app/api/cron/lab-results/route.ts");
const viewRoute = await import("../src/app/api/lab-results/view/route.ts");
const listRoute = await import("../src/app/api/lab-results/route.ts");

const realFetch = globalThis.fetch;
const MIN = 60_000;
const LINE_USER = "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_USER = "Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const GROUP = "C0123456789abcdef0123456789abcdef";
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

let labs, pdfVersion, outbound, loginCount, listCalls, labStatus, labPages, listQueries, cursorShape;
const item = (id, extra = {}) => ({
  id, ln: `LN${26200000 + (Number(id) || 0)}`, lis_ln: null, hn: "BML1", location_hn: "4714", location_hn_extraction_status: "ok",
  patient_name: "สมชาย ใจดี", gender: "M", order_datetime: iso(2 * 3_600_000), status: "completed",
  imported_at: iso(3_600_000), current_version_number: 1, version_count: 1, ...extra,
});

beforeEach(() => {
  resetDb({
    settings: [{ key: "clinic_profile", value: { name: "คลินิกทดสอบ" } }],
    channels: [{ id: "line", type: "line", name: "LINE", enabled: true, created_at: nextTime() }, { id: "fb", type: "facebook", name: "FB", enabled: true, created_at: nextTime() }],
    contacts: [
      { id: "c1", channel_id: "line", external_id: LINE_USER, display_name: "สมชาย", language: "th" },
      { id: "c2", channel_id: "line", external_id: OTHER_USER, display_name: "คนอื่น", language: "th" },
      { id: "c3", channel_id: "fb", external_id: "fb-1", display_name: "FB", language: "th" },
    ],
    conversations: [
      { id: "conv1", contact_id: "c1", channel_id: "line", status: "open", tags: [], archived: false },
      { id: "conv2", contact_id: "c2", channel_id: "line", status: "open", tags: [], archived: false },
      { id: "conv3", contact_id: "c3", channel_id: "fb", status: "open", tags: [], archived: false },
    ],
    patients: [{ hn: "000004714", full_name: "สมชาย ใจดี" }, { hn: "000000555", full_name: "ไม่มีไลน์" }, { hn: "000000777", full_name: "เฟซบุ๊กอย่างเดียว" }],
    patient_links: [
      { conversation_id: "conv1", hn: "000004714", role: "patient", linked_at: nextTime() },
      { conversation_id: "conv3", hn: "000000777", role: "patient", linked_at: nextTime() },
    ],
    appointments: [], appointment_events: [], lab_results: [], line_sends: [],
    staff: [{ id: "agent", role: "agent", active: true, display_name: "เอ", must_change_password: false }],
  });
  state.currentUser = { id: "agent", email: "a@test" };
  process.env.BML_USERNAME = "clinic";
  process.env.BML_PASSWORD = "pw";
  process.env.LAB_SYNC_SECRET = "lab-s3cret";
  process.env.CRON_SECRET = "cron-s3cret";
  process.env.LINE_LOGIN_CHANNEL_ID = "2000000000";
  process.env.NEXT_PUBLIC_LINE_LIFF_ID = "2000000000-abcd";
  delete process.env.LAB_TEAM_LINE_GROUP_ID;
  delete process.env.LAB_TEAM_NOTIFY;
  bml.resetBmlSession();
  labs = [];
  pdfVersion = {};
  outbound = [];
  loginCount = 0;
  listCalls = 0;
  labStatus = 200;
  labPages = null;
  listQueries = [];
  cursorShape = (last) => ({ cursor_value: last.order_datetime, cursor_id: String(last.id) });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    outbound.push({ url: u, method, headers: init.headers ?? {}, body: init.body });
    if (u.startsWith(bml.BML_BASE)) {
      assert.ok(method === "GET" || u.endsWith("/api/login"), `ห้ามเรียก ${method} ${u} ในระบบแล็บ`);
      if (u.endsWith("/api/login")) {
        loginCount++;
        assert.deepEqual(JSON.parse(init.body), { username: "clinic", password: "pw" });
        return new Response("{}", { status: 200, headers: { "set-cookie": `session=s${loginCount}; Path=/; HttpOnly` } });
      }
      if (init.headers?.cookie !== `session=s${loginCount}`) return new Response("{}", { status: 401 });
      if (labStatus !== 200) { const s = labStatus; labStatus = 200; return new Response("{}", { status: s }); }
      if (u.includes("/api/labs?")) {
        listCalls++;
        const q = new URL(u).searchParams;
        assert.equal(q.get("page_size"), "100");
        assert.equal(q.get("location_id"), "177");
        listQueries.push(Object.fromEntries(q));
        if (labPages) {
          // แบ่งหน้าแบบเว็บแล็บ: next_cursor เป็น object → ส่งกลับมาเป็น cursor_value + cursor_id
          const cid = q.get("cursor_id");
          const idx = cid ? labPages.findIndex((pg) => String(pg.at(-1).id) === cid) + 1 : 0;
          const items = labPages[idx] ?? [];
          const more = idx < labPages.length - 1;
          return Response.json({ items, has_more: more, next_cursor: more ? cursorShape(items.at(-1)) : null });
        }
        return Response.json({ items: labs, has_more: false, next_cursor: null });
      }
      const m = u.match(/\/api\/labs\/([^/]+)\/pdf$/);
      if (m) return new Response(Buffer.from(`%PDF-1.4 scan ${m[1]} v${pdfVersion[m[1]] ?? 1}`), { headers: { "content-type": "application/pdf" } });
      return new Response("{}", { status: 404 });
    }
    if (u === "https://api.line.me/oauth2/v2.1/verify") {
      const p = new URLSearchParams(init.body);
      assert.equal(p.get("client_id"), "2000000000");
      const sub = { "tok-owner": LINE_USER, "tok-other": OTHER_USER }[p.get("id_token")];
      return sub ? Response.json({ sub, aud: "2000000000" }) : Response.json({ error: "invalid_request" }, { status: 400 });
    }
    return Response.json({}); // LINE push
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const pushes = () => outbound.filter((o) => o.url.endsWith("/message/push")).map((o) => JSON.parse(o.body));
const row = (bmlId) => state.tables.lab_results.find((r) => r.bml_id === bmlId);
/** รอบแรกของระบบ (ผลเก่าไม่แจ้ง) แล้วคืนเวลาของรอบถัดไป */
async function initialize(now) {
  const s = await store.runLabSync(now);
  assert.equal(s.backfill, true);
  return now + 60 * MIN;
}

test("กติกา: HN จากแล็บ · ระยะห่างรอบ · ผลใหม่/แก้ผล · นัดฟังผล", () => {
  assert.equal(rules.labHn("4714", "ok"), "000004714");
  assert.equal(rules.labHn("HN 4714", "OK"), "000004714");
  for (const [hn, st] of [["4714", "failed"], ["", "ok"], [null, "ok"], ["AB12", "ok"], ["1234567890", "ok"]]) assert.equal(rules.labHn(hn, st), null, `${hn}/${st}`);

  const t = Date.parse("2026-11-18T06:00:00Z");
  assert.equal(rules.syncDue({}, t), true);
  assert.equal(rules.syncDue({ last_run_at: new Date(t - 10 * MIN).toISOString() }, t), false, "ห้ามถี่กว่า 15 นาที");
  assert.equal(rules.syncDue({ last_run_at: new Date(t - 60 * MIN).toISOString() }, t), true);

  assert.equal(rules.syncAction(null, 1), "new");
  assert.equal(rules.syncAction({ version_number: 1, pdf_path: "a", pdf_version: 1 }, 1), "same");
  assert.equal(rules.syncAction({ version_number: 1, pdf_path: "a", pdf_version: 1 }, 2), "updated");
  assert.equal(rules.syncAction({ version_number: 1, pdf_path: null }, 1), "updated", "ไฟล์รอบก่อนโหลดไม่สำเร็จ ลองใหม่");

  const appts = [
    { id: "a1", appoint_date: "2026-11-20", time_mode: "exact", time_start: "10:00:00", time_end: null, status: "scheduled", purpose_text: "เจาะเลือด" },
    { id: "a2", appoint_date: "2026-11-25", time_mode: "exact", time_start: "09:00:00", time_end: null, status: "scheduled", purpose_text: "ฟังผลแล็บ" },
    { id: "a3", appoint_date: "2026-11-22", time_mode: "exact", time_start: "09:00:00", time_end: null, status: "cancelled", purpose_text: "ฟังผลเลือด" },
  ];
  assert.equal(rules.resultHearingAppointment(appts, "2026-11-18")?.id, "a2");
  assert.equal(rules.resultHearingAppointment(appts, "2026-11-26"), null);
});

test("cron: ต้องมี header x-lab-sync-secret = LAB_SYNC_SECRET (ไม่รับ CRON_SECRET)", async () => {
  const call = (headers) => cronRoute.POST(new Request("https://app.test/api/cron/lab-results", { method: "POST", headers }));
  assert.equal((await call({})).status, 401);
  assert.equal((await call({ "x-lab-sync-secret": "wrong" })).status, 401);
  assert.equal((await call({ authorization: "Bearer cron-s3cret" })).status, 401, "CRON_SECRET เดิมใช้ไม่ได้");
  delete process.env.LAB_SYNC_SECRET;
  assert.equal((await call({ "x-lab-sync-secret": "" })).status, 401, "ไม่ได้ตั้ง env = ปิด");
  process.env.LAB_SYNC_SECRET = "lab-s3cret";
  const ok = await call({ "x-lab-sync-secret": "lab-s3cret" });
  assert.equal(ok.status, 200);
  assert.ok(state.tables.system_heartbeat.some((h) => h.name === "cron_lab_results"));
  delete process.env.BML_PASSWORD;
  bml.resetBmlSession();
  state.tables.settings = state.tables.settings.filter((s) => s.key !== rules.LAB_SYNC_STATE_KEY);
  assert.equal((await call({ "x-lab-sync-secret": "lab-s3cret" })).status, 503);
});

test("รอบแรก: ผลก่อน LN 26129150 ไม่นำเข้า · ผลตั้งแต่ LN นี้เก็บ + PDF + จับคู่ · เรียกซ้ำภายใน 15 นาทีไม่แตะระบบแล็บ", async () => {
  labs = [item("101", { ln: "26129001" }), item("102", { location_hn: "", location_hn_extraction_status: "failed" })];
  const now = Date.now();
  await initialize(now);
  assert.equal(state.tables.lab_results.length, 1);
  assert.equal(row("101"), undefined, "LN ก่อนคนไข้รายแรกไม่นำเข้า");
  assert.equal(row("102").match_status, "unmatched");
  assert.equal(row("102").pdf_path, "102/v1.pdf");
  assert.ok(state.files[rules.LAB_BUCKET].has("102/v1.pdf"));
  assert.equal(pushes().length, 0, "ยังไม่จับคู่ ไม่ส่ง");

  const before = outbound.length;
  const again = await store.runLabSync(now + 5 * MIN);
  assert.equal(again.skipped, "too_soon");
  assert.equal(outbound.length, before, "ไม่เรียกระบบแล็บซ้ำ");
});

test("ผลใหม่: แจ้งคนไข้ทาง LINE ทันที (Flex + ปุ่มดูผลผ่าน LIFF ไม่แนบ PDF) + แจ้งทีม + นัดฟังผล", async () => {
  state.tables.settings.push({ key: rules.LAB_TEAM_GROUP_KEY, value: { group_id: GROUP } });
  process.env.LAB_TEAM_NOTIFY = "on";
  state.tables.appointments.push({
    id: "11111111-2222-4333-8444-555555555555", hn: "000004714", appoint_date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), time_mode: "exact", time_start: "10:30:00", time_end: null,
    status: "scheduled", purpose_text: "ฟังผลแล็บ", telemed_id: null,
  });
  const next = await initialize(Date.now());
  labs = [item("201")];
  const s = await store.runLabSync(next);
  assert.equal(s.created, 1);
  assert.equal(s.notified, 1);
  assert.equal(s.team, 1);

  const [toPatient, toTeam] = pushes();
  assert.equal(toPatient.to, LINE_USER);
  const flex = JSON.stringify(toPatient.messages);
  assert.match(flex, /ผลแล็บของคุณออกแล้ว/);
  assert.ok(toPatient.messages.every((m) => m.type === "flex"), "ไม่ส่งไฟล์ PDF ในแชท");
  assert.match(flex, new RegExp(`https://liff.line.me/2000000000-abcd\\?id=${row("201").id}`));
  assert.match(flex, /appt:confirm:11111111-2222-4333-8444-555555555555/);
  assert.match(flex, /appt:reschedule:11111111-2222-4333-8444-555555555555/);
  assert.match(flex, /นัดฟังผล/);
  assert.doesNotMatch(flex, /storage\.test|%PDF/);

  assert.equal(toTeam.to, GROUP);
  const team = toTeam.messages[0].text;
  assert.match(team, /ผลแล็บใหม่/);
  assert.match(team, /สมชาย ใจดี/);
  assert.match(team, /HN: 4714/);
  assert.match(team, new RegExp(`/lab-results\\?id=${row("201").id}`));

  assert.equal(row("201").notify_status, "sent");
  assert.equal(row("201").notified_version, 1);
  // ข้อความในแชทเป็นข้อความระบบ (AI ข้าม) ไม่มีค่าผล/ลิงก์ไฟล์
  const msg = state.tables.messages.find((m) => m.conversation_id === "conv1");
  assert.equal(msg.sender_type, "system");
  assert.equal(msg.imported_sender_name, rules.LAB_SENDER_NAME);
  assert.doesNotMatch(msg.body, /storage\.test|%PDF/);
  assert.ok(state.tables.line_sends.every((l) => l.kind === "lab"));
});

test("แล็บแก้ผล (version ใหม่): เก็บไฟล์ใหม่ + แจ้ง \"ผลมีการปรับปรุง\"", async () => {
  const next = await initialize(Date.now());
  labs = [item("301")];
  await store.runLabSync(next);
  labs = [item("301", { current_version_number: 2, version_count: 2 })];
  pdfVersion["301"] = 2;
  const s = await store.runLabSync(next + 60 * MIN);
  assert.equal(s.updated, 1);
  assert.equal(row("301").version_number, 2);
  assert.equal(row("301").pdf_path, "301/v2.pdf");
  assert.match(String(state.files[rules.LAB_BUCKET].get("301/v2.pdf").data), /v2/);
  const last = pushes().at(-1);
  assert.match(JSON.stringify(last.messages), /ผลแล็บของคุณมีการปรับปรุง/);
  assert.equal(row("301").notified_version, 2);

  // รอบถัดไปไม่มีอะไรเปลี่ยน: ไม่ส่งซ้ำ ไม่โหลด PDF ซ้ำ
  const n = pushes().length;
  const pdfCalls = outbound.filter((o) => o.url.endsWith("/pdf")).length;
  await store.runLabSync(next + 120 * MIN);
  assert.equal(pushes().length, n);
  assert.equal(outbound.filter((o) => o.url.endsWith("/pdf")).length, pdfCalls);
});

test("ไม่ได้ผูก LINE: ไม่ส่งแจ้งใด ๆ ไม่เข้ารายการโทร แสดงสถานะ \"ไม่ได้ผูก LINE\" · ผลยังเก็บไว้", async () => {
  const next = await initialize(Date.now());
  labs = [item("401", { location_hn: "555" }), item("402", { location_hn: "777" })];
  await store.runLabSync(next);
  assert.equal(pushes().length, 0);
  for (const id of ["401", "402"]) {
    assert.equal(row(id).notify_status, "unreachable", `${id}: Facebook อย่างเดียวก็ไม่ส่ง (แจ้งทาง LINE เท่านั้น)`);
    assert.ok(row(id).pdf_path, "ผลยังเก็บไว้ แพทย์เปิดได้");
  }
  assert.equal(rules.NOTIFY_LABEL.unreachable, "ไม่ได้ผูก LINE");
  assert.ok(rules.inLabTab(row("401"), "nolink"));
  assert.equal(await store.staffPdfUrl(row("401").id), "https://storage.test/signed/lab-results/401/v1.pdf");
});

test("HN อ่านไม่ได้ → ยังไม่จับคู่ · เจ้าหน้าที่จับคู่เองแล้วแจ้งคนไข้ · รอบ sync ถัดไปไม่ทับการจับคู่เอง", async () => {
  const next = await initialize(Date.now());
  labs = [item("501", { location_hn: null, location_hn_extraction_status: "not_found" })];
  await store.runLabSync(next);
  assert.equal(row("501").match_status, "unmatched");
  assert.equal(pushes().length, 0);
  const r = await store.matchLabResult(row("501").id, "4714", "agent");
  assert.equal(r.notify.sent, true);
  assert.equal(row("501").match_status, "manual");
  assert.equal(row("501").patient_id, "000004714");
  assert.equal(pushes().length, 1);
  await store.runLabSync(next + 60 * MIN);
  assert.equal(row("501").patient_id, "000004714");
  assert.equal(pushes().length, 1, "ไม่ส่งซ้ำ");
});

test("session หมดอายุ (401): login ใหม่ 1 ครั้งแล้วทำต่อ", async () => {
  labs = [];
  const now = Date.now();
  await store.runLabSync(now);
  assert.equal(loginCount, 1);
  labStatus = 401;
  await store.runLabSync(now + 60 * MIN);
  assert.equal(loginCount, 2);
  assert.equal(listCalls, 2);
});

test("คนไข้เปิดผลผ่าน LIFF: ตรวจ ID token กับ LINE · เฉพาะบัญชีที่ผูก HN · signed URL ≤ 10 นาที · นับการเปิด", async () => {
  const next = await initialize(Date.now());
  labs = [item("601")];
  await store.runLabSync(next);
  const id = row("601").id;
  const view = (body) => viewRoute.POST(new Request("https://app.test/api/lab-results/view", { method: "POST", body: JSON.stringify(body) }));

  assert.equal((await view({ id })).status, 400);
  assert.equal((await view({ id, idToken: "bad" })).status, 401);
  assert.equal((await view({ id, idToken: "tok-other" })).status, 404, "บัญชีอื่นเปิดไม่ได้");
  assert.equal(row("601").view_count, 0);

  const res = await view({ id, idToken: "tok-owner" });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.url, "https://storage.test/signed/lab-results/601/v1.pdf");
  assert.ok(j.expiresIn <= 600);
  assert.equal(row("601").view_count, 1);
  const first = row("601").first_viewed_at;
  assert.ok(first);
  await view({ id, idToken: "tok-owner" });
  assert.equal(row("601").view_count, 2);
  assert.equal(row("601").first_viewed_at, first);
});

test("แผงขวาแชท: เห็นผลของ HN ที่ผูกกับแชท · ห้องยาเข้าไม่ได้", async () => {
  const next = await initialize(Date.now());
  labs = [item("701"), item("702", { location_hn: "555" })];
  await store.runLabSync(next);
  const res = await listRoute.GET(new Request("https://app.test/api/lab-results?conversation=conv1"));
  const ids = (await res.json()).results.map((r) => r.bml_id).sort();
  assert.deepEqual(ids, ["701"]);
  state.tables.staff.push({ id: "nurse", role: "pharmacy", active: true, display_name: "พยาบาล", must_change_password: false });
  state.currentUser = { id: "nurse", email: "n@test" };
  assert.equal((await listRoute.GET(new Request("https://app.test/api/lab-results"))).status, 403);
});

test("migration + cron: RLS เฉพาะ staff · bucket private · pg_cron ชั่วโมงละครั้ง 13–18 น. อ่าน secret จาก Vault", () => {
  const sql = readFileSync("supabase/migrations/061_lab_results.sql", "utf8");
  assert.match(sql, /bml_id text not null unique/);
  assert.match(sql, /patient_id text references patients\(hn\)/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /using \(is_staff\(\)\)/);
  assert.match(sql, /'lab-results', 'lab-results', false/);
  const cron = readFileSync("supabase/manual/061_lab_sync_cron.sql", "utf8");
  assert.match(cron, /'\*\/30 6-11 \* \* \*'/); // ทุก 30 นาที 13:00–18:30 น.
  assert.match(cron, /'x-lab-sync-secret'/);
  assert.match(cron, /vault\.decrypted_secrets where name = 'LAB_SYNC_SECRET'/);
  assert.doesNotMatch(cron, /docdesk_cron_secret|CRON_SECRET'/);
  // ค่าลับไม่อยู่ในโค้ด
  for (const f of ["src/lib/bml-client.ts", "src/lib/lab-results-store.ts", "supabase/manual/061_lab_sync_cron.sql", ".env.example"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /BML_PASSWORD=[^\s#]/, f);
  }
});

test("ผลแล็บไม่เข้า AI: โมดูล AI ไม่อ่านตาราง lab_results", () => {
  for (const f of ["src/lib/suggest.ts", "src/lib/ai.ts", "src/lib/pipeline.ts"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /lab_results|lab-results-store/, f);
  }
});

test("แจ้งกลุ่มแพทย์พักไว้: ค่าเริ่มต้นไม่ส่งเข้ากลุ่ม แม้ตั้งกลุ่มไว้", async () => {
  state.tables.settings.push({ key: rules.LAB_TEAM_GROUP_KEY, value: { group_id: GROUP } });
  const next = await initialize(Date.now());
  labs = [item("801")];
  const s = await store.runLabSync(next);
  assert.equal(s.team, 0);
  assert.deepEqual(pushes().map((p) => p.to), [LINE_USER]);
});

test("ไทม์ไลน์แชท: บันทึกข้อความแจ้งผลพร้อมป้าย \"ส่งอัตโนมัติ · ผลแล็บ\"", async () => {
  const next = await initialize(Date.now());
  labs = [item("901")];
  await store.runLabSync(next);
  const msgs = state.tables.messages.filter((m) => m.conversation_id === "conv1");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].imported_sender_name, "ส่งอัตโนมัติ · ผลแล็บ");
  assert.equal(msgs[0].direction, "out");
  assert.match(msgs[0].body, /ผลแล็บของคุณออกแล้ว/);
});

test("LINE ส่งไม่สำเร็จ (บล็อก/เลิกติดตาม/error): สถานะ \"ส่งไม่สำเร็จ\" + เก็บ error + ตัวกรอง", async () => {
  const next = await initialize(Date.now());
  // เลิกติดตาม OA แล้ว: ไม่ยิง push แต่ขึ้นส่งไม่สำเร็จ (ไม่ใช่ "ไม่ได้ผูก LINE")
  state.tables.contacts.find((c) => c.id === "c1").line_unfollowed_at = iso(MIN);
  labs = [item("911")];
  await store.runLabSync(next);
  assert.equal(pushes().length, 0);
  assert.equal(row("911").notify_status, "failed");
  assert.match(row("911").notify_error, /บล็อกหรือเลิกติดตาม/);
  assert.ok(rules.inLabTab(row("911"), "failed"));
  assert.ok(!rules.inLabTab(row("911"), "nolink"));
  assert.ok(rules.LAB_TABS.some((t) => t.key === "failed" && t.label === "ส่งไม่สำเร็จ"));

  // LINE ตอบ error: เก็บข้อความจริงไว้ดู ไม่บันทึกลงไทม์ไลน์
  state.tables.contacts.find((c) => c.id === "c1").line_unfollowed_at = null;
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).endsWith("/message/push")
    ? new Response('{"message":"Failed to send messages"}', { status: 400 })
    : base(url, init));
  labs = [item("912")];
  await store.runLabSync(next + 60 * MIN);
  assert.equal(row("912").notify_status, "failed");
  assert.match(row("912").notify_error, /400/);
  assert.equal(state.tables.messages.filter((m) => m.conversation_id === "conv1").length, 0);
  assert.match(store.lineErrorText(new Error('LINE push failed 403: {"message":"blocked"}')), /บล็อก/);
});

const mineRoute = await import("../src/app/api/lab-results/mine/route.ts");
const confirmRoute = await import("../src/app/api/lab-results/confirm/route.ts");
const labChat = await import("../src/lib/lab-chat-reply.ts");
const postJson = (route, body) => route.POST(new Request("https://app.test/x", { method: "POST", body: JSON.stringify(body) }));
const APPT = "22222222-3333-4444-8555-666666666666";
const addHearing = (status = "scheduled") => state.tables.appointments.push({
  id: APPT, hn: "000004714", conversation_id: "conv1", appoint_date: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
  time_mode: "exact", time_start: "09:30:00", time_end: null, status, purpose_text: "ฟังผลเลือด", telemed_id: null,
});

test("sync ครั้งแรก: ผลก่อน LN 26129150 ไม่นำเข้า ไม่ส่ง LINE · ผลที่เข้ามาหลังจากนั้นแจ้งตามปกติ", async () => {
  labs = [item("1001", { ln: "26129001" }), item("1002", { ln: "26129002", location_hn: "555" })];
  const next = await initialize(Date.now());
  assert.equal(row("1001"), undefined);
  assert.equal(row("1002"), undefined);
  assert.equal(pushes().length, 0);
  assert.equal(state.tables.messages.length, 0);
  labs = [item("1001", { ln: "26129001" }), item("1002", { ln: "26129002", location_hn: "555" }), item("1003")];
  await store.runLabSync(next);
  assert.deepEqual(pushes().map((p) => p.to), [LINE_USER], "แจ้งเฉพาะผลใหม่ 1003");
  assert.equal(row("1003").notify_status, "sent");
  assert.equal(row("1001"), undefined);
});

test("Flex แจ้งผล: มีลิงก์ \"ดูผลแล็บทั้งหมดของฉัน\" ไปหน้า LIFF", async () => {
  const next = await initialize(Date.now());
  labs = [item("1101")];
  await store.runLabSync(next);
  const flex = JSON.stringify(pushes()[0].messages);
  assert.match(flex, /ดูผลแล็บทั้งหมดของฉัน/);
  assert.match(flex, /https:\/\/liff\.line\.me\/2000000000-abcd\?mine=1/);
});

test("LIFF ผลแล็บของฉัน: เฉพาะผลของ HN ที่บัญชีนี้ผูก เรียงล่าสุดก่อน + วันที่ตรวจ, LN, นัดฟังผล", async () => {
  addHearing();
  const next = await initialize(Date.now());
  labs = [item("1201", { order_datetime: iso(5 * 86_400_000) }), item("1202", { order_datetime: iso(3_600_000) }), item("1203", { location_hn: "555" })];
  await store.runLabSync(next);
  assert.equal((await postJson(mineRoute, {})).status, 400);
  assert.equal((await postJson(mineRoute, { idToken: "bad" })).status, 401);
  const mine = await (await postJson(mineRoute, { idToken: "tok-owner" })).json();
  assert.equal(mine.linked, true);
  assert.deepEqual(mine.results.map((r) => r.ln), ["LN26201202", "LN26201201"]);
  assert.ok(mine.results[0].orderDate);
  assert.match(mine.results[0].appointment.when, /09:30/);
  assert.ok(!JSON.stringify(mine).includes("storage.test"), "รายการไม่มีลิงก์ไฟล์ เปิดทีละรายการ");
  const other = await (await postJson(mineRoute, { idToken: "tok-other" })).json();
  assert.deepEqual(other, { linked: false, results: [], lang: "th" }, "ภาษาของบัญชี (ไทย) ส่งไปกับรายการ");
});

test("หน้าดูผล: ปุ่มดาวน์โหลด PDF + วันนัด + ยืนยันนัดได้เฉพาะบัญชีที่ผูก", async () => {
  addHearing();
  const next = await initialize(Date.now());
  labs = [item("1301")];
  await store.runLabSync(next);
  const v = await (await postJson(viewRoute, { id: row("1301").id, idToken: "tok-owner" })).json();
  assert.ok(v.downloadUrl.startsWith("https://storage.test/signed/lab-results/"));
  assert.equal(v.appointment.id, APPT);
  assert.equal(v.appointment.canConfirm, true);
  assert.equal(v.ln, "LN26201301");

  assert.equal((await postJson(confirmRoute, { appointmentId: APPT, idToken: "tok-other" })).status, 404);
  assert.equal(state.tables.appointments[0].status, "scheduled");
  const ok = await postJson(confirmRoute, { appointmentId: APPT, idToken: "tok-owner" });
  assert.equal(ok.status, 200);
  assert.equal(state.tables.appointments[0].status, "confirmed");
  assert.ok(state.tables.appointment_events.some((e) => e.appointment_id === APPT && e.kind === "confirmed"));
});

test("คนไข้ขอผลแล็บในแชท: ตอบแค่ปุ่มลิงก์ \"ผลแล็บของฉัน\" ไม่เรียก AI ไม่มีเนื้อหาผล", async () => {
  for (const t of ["ขอผลแล็บหน่อยค่ะ", "ผลเลือดออกหรือยังคะ", "อยากดูผลตรวจ", "lab result please"]) assert.ok(rules.isLabResultRequest(t), t);
  for (const t of ["ตรวจเลือดราคาเท่าไหร่", "ขอนัดเจาะเลือด", "สวัสดีค่ะ"]) assert.ok(!rules.isLabResultRequest(t), t);

  assert.equal(await labChat.replyLabLinkIfAsked("conv1", "สวัสดีค่ะ"), false);
  assert.equal(await labChat.replyLabLinkIfAsked("conv3", "ขอผลแล็บหน่อย"), false, "Facebook: ไม่ตอบแบบนี้ ให้ AI/เจ้าหน้าที่ตามปกติ");
  assert.equal(await labChat.replyLabLinkIfAsked("conv1", "ขอผลแล็บหน่อย", "reply-tok"), true);
  const reply = outbound.find((o) => o.url.endsWith("/message/reply"));
  const sent = JSON.parse(reply.body);
  assert.equal(sent.messages.length, 1);
  assert.match(JSON.stringify(sent.messages), /ผลแล็บของฉัน/);
  assert.match(JSON.stringify(sent.messages), /\?mine=1/);
  const m = state.tables.messages.find((x) => x.conversation_id === "conv1");
  assert.equal(m.sender_type, "ai");
  assert.doesNotMatch(m.body, /storage|LN\d|%PDF/);

  const pipeline = readFileSync("src/lib/pipeline.ts", "utf8");
  assert.ok(pipeline.indexOf("replyLabLinkIfAsked(") < pipeline.indexOf("await generateSuggestions(conversationId)"), "ตอบลิงก์ก่อนเรียก LLM");
  assert.doesNotMatch(readFileSync("src/lib/lab-chat-reply.ts", "utf8"), /lab_results|lab-results-store/, "ตัวตอบลิงก์ไม่อ่านข้อมูลผล");
});

test("หน้า admin: ตัวกรองสถานะ · ช่วงวันที่ · การ์ดสรุป · badge รอจับคู่", async () => {
  assert.deepEqual(rules.LAB_TABS.map((t) => t.label), ["ทั้งหมด", "ไม่พบ HN", "ยังไม่เปิดดู", "ไม่ได้ผูก LINE", "ส่งไม่สำเร็จ"]);
  labs = [item("1401", { order_datetime: "2026-01-05T03:00:00Z" })];
  const next = await initialize(Date.now());
  labs = [item("1401", { order_datetime: "2026-01-05T03:00:00Z" }), item("1402"), item("1403", { location_hn: null, location_hn_extraction_status: "failed" })];
  await store.runLabSync(next);
  // ฐานข้อมูลจำลองใช้นาฬิกาของตัวเอง: ให้เวลานำเข้าเป็นตอนนี้ (ผลเก่า 1401 นำเข้าเมื่อวาน)
  for (const r of state.tables.lab_results) r.created_at = r.bml_id === "1401" ? iso(30 * 3_600_000) : new Date().toISOString();
  const get = async (qs) => (await listRoute.GET(new Request(`https://app.test/api/lab-results?${qs}`))).json();
  const all = await get("tab=all");
  assert.deepEqual(all.summary, { today: 2, unmatched: 1, unviewed: 1 });
  assert.deepEqual((await get("tab=all&from=2026-01-05&to=2026-01-05")).results.map((r) => r.bml_id), ["1401"]);
  assert.deepEqual((await get("tab=unmatched")).results.map((r) => r.bml_id), ["1403"]);
  assert.deepEqual(await get("counts=1"), { unmatched: 1 });
  assert.deepEqual(rules.bangkokDateRange("2026-01-05", "2026-01-05"), { gte: "2026-01-04T17:00:00.000Z", lt: "2026-01-05T17:00:00.000Z" });
});

test("ไม่มีปุ่มส่งผลซ้ำ: API ไม่รับ action resend", async () => {
  const idRoute = await import("../src/app/api/lab-results/[id]/route.ts");
  const next = await initialize(Date.now());
  labs = [item("1501")];
  await store.runLabSync(next);
  const res = await idRoute.PATCH(new Request("https://app.test/x", { method: "PATCH", body: JSON.stringify({ action: "resend" }) }), { params: Promise.resolve({ id: row("1501").id }) });
  assert.equal(res.status, 400);
  assert.doesNotMatch(readFileSync("src/app/(staff)/lab-results/lab-results-client.tsx", "utf8"), /ส่งแจ้งซ้ำ|resend/);
});

test("แบ่งหน้า /api/labs: next_cursor (object) → cursor_value + cursor_id · has_more=false หยุด", async () => {
  const h = 3_600_000;
  labPages = [
    [item("2001", { order_datetime: iso(1 * h) }), item("2002", { order_datetime: iso(2 * h) })],
    [item("2003", { order_datetime: iso(3 * h) })],
    [item("2004", { order_datetime: iso(4 * h) })],
  ];
  await store.runLabSync(Date.now());
  assert.equal(listQueries.length, 3);
  assert.equal(listQueries[0].cursor_value, undefined);
  assert.equal(listQueries[0].cursor, undefined);
  assert.equal(listQueries[1].cursor_id, "2002");
  assert.equal(listQueries[1].cursor_value, labPages[0][1].order_datetime);
  assert.equal(listQueries[2].cursor_id, "2003");
  for (const qy of listQueries) assert.ok(!("cursor" in qy) && !("before_datetime" in qy) && !("before_id" in qy));
  assert.equal(state.tables.lab_results.length, 4);

  // ชื่อ field อื่นที่เป็นไปได้ · อ่านไม่ได้ = หยุด ไม่วนซ้ำ
  assert.deepEqual(bml.parseBmlCursor({ value: "2026-11-18T05:00:00Z", id: 7 }), { value: "2026-11-18T05:00:00Z", id: "7" });
  assert.deepEqual(bml.parseBmlCursor({ order_datetime: "x", id: "a" }), { value: "x", id: "a" });
  for (const bad of [null, "abc", {}, { cursor_value: "x" }, []]) assert.equal(bml.parseBmlCursor(bad), null);
});

test("แบ่งหน้า: cursor อ่านไม่ได้ หยุดหลังหน้าแรก (ไม่วนไม่จบ)", async () => {
  labPages = [[item("2101")], [item("2102")]];
  cursorShape = () => ({ something_else: 1 });
  await store.runLabSync(Date.now());
  assert.equal(listQueries.length, 1);
});

test("ยังไม่ได้ตั้ง LIFF: ไม่ส่ง LINE (ปุ่มดูผลจะเปิดไม่ได้) ค้างเป็นรอแจ้ง · ตั้งแล้วรอบถัดไปส่งเอง", async () => {
  const next = await initialize(Date.now());
  delete process.env.NEXT_PUBLIC_LINE_LIFF_ID;
  labs = [item("2201")];
  await store.runLabSync(next);
  assert.equal(pushes().length, 0);
  assert.equal(row("2201").notify_status, "pending");
  assert.match(row("2201").notify_error, /LIFF/);
  process.env.NEXT_PUBLIC_LINE_LIFF_ID = "2000000000-abcd";
  await store.runLabSync(next + 60 * MIN);
  assert.equal(pushes().length, 1);
  assert.equal(row("2201").notify_status, "sent");
  assert.equal(row("2201").notify_error, null);
});

test("เริ่มระบบที่ LN 26129150: LN ที่น้อยกว่าไม่นำเข้า · ตั้งแต่ LN นี้แจ้งได้ในรอบแรก", async () => {
  assert.equal(rules.labBeforeStart("26129149"), true);
  assert.equal(rules.labBeforeStart("26129150"), false);
  assert.equal(rules.labBeforeStart("LN26129151"), false);
  assert.equal(rules.labBeforeStart(null), false, "ไม่มี LN = นำเข้าตามปกติ (ไม่ทิ้งผลใหม่)");
  assert.equal(rules.labBeforeStart(""), false);
  labs = [
    item("2301", { ln: "26129150" }),
    item("2302", { ln: "26129151", location_hn: "555" }),
    item("2303", { ln: "26129149" }),
  ];
  const s = await store.runLabSync(Date.now());
  assert.equal(s.backfill, true);
  assert.equal(row("2303"), undefined, "LN ก่อน 26129150 ไม่นำเข้าระบบ");
  assert.equal(row("2301").notify_status, "sent", "LN 26129150 แจ้งในรอบแรก");
  assert.equal(row("2302").notify_status, "unreachable");
  assert.deepEqual(pushes().map((p) => p.to), [LINE_USER]);
  assert.equal(s.notified, 1);
});

test("ไม่ได้ผูก LINE ตอนผลออก: ผูกทีหลังไม่แจ้งอัตโนมัติ (รอเจ้าหน้าที่กดส่ง)", () => {
  const base = { patient_id: "4807", pdf_path: "x.pdf", status: "final", order_datetime: new Date().toISOString(), notified_version: null, version_number: 1 };
  assert.equal(rules.shouldAutoNotify({ ...base, notify_status: "pending" }), true);
  assert.equal(rules.shouldAutoNotify({ ...base, notify_status: "unreachable" }), false);
});

test("เวลาจากระบบแล็บไม่มีโซนเวลา = เวลาไทย (+07:00)", () => {
  assert.equal(rules.bmlTime("2026-11-17T14:50:00"), "2026-11-17T14:50:00+07:00");
  assert.equal(rules.bmlTime("2026-11-17 14:50:00"), "2026-11-17T14:50:00+07:00");
  assert.equal(rules.bmlTime("2026-11-17T07:50:00Z"), "2026-11-17T07:50:00Z");
  assert.equal(rules.bmlTime("2026-11-17T14:50:00+07:00"), "2026-11-17T14:50:00+07:00");
  assert.equal(rules.bmlTime(null), null);
});

// ---------------------------------------------------------------------------
// ขอนัดฟังผลจากการ์ดผลแล็บ
// ---------------------------------------------------------------------------
const bookingRules = await import("../src/lib/booking-rules.ts");
const bookingRoute = await import("../src/app/api/lab-results/booking/route.ts");
const requestRoute = await import("../src/app/api/lab-results/request-appointment/route.ts");
const apptStore = await import("../src/lib/appointment-store.ts");
// จันทร์–เสาร์ 09:00–17:00 · อาทิตย์ปิด
const HOURS = { tz: "Asia/Bangkok", days: { 0: null, 1: ["09:00", "17:00"], 2: ["09:00", "17:00"], 3: ["09:00", "17:00"], 4: ["09:00", "17:00"], 5: ["09:00", "17:00"], 6: ["09:00", "17:00"] } };
const withHours = () => state.tables.settings.push({ key: "business_hours", value: HOURS });

test("เลือกวันนัดเอง: 8 วันเปิดถัดไป ทีละ 30 นาที ตามเวลาเปิด ข้ามวันปิด ไม่ให้เลือกเวลาที่ผ่านไปแล้ว", () => {
  const now = Date.parse("2026-11-18T10:10:00+07:00"); // พุธ 10:10 น.
  const days = bookingRules.selfBookingDays(HOURS, now);
  assert.equal(days[0].date, "2026-11-18");
  assert.equal(days[0].times[0], "10:30", "วันนี้เริ่มหลังเวลาปัจจุบัน");
  assert.equal(days[0].times.at(-1), "16:30", "ช่วงสุดท้ายก่อนปิด 30 นาที");
  assert.ok(!days.some((d) => d.date === "2026-11-22"), "อาทิตย์ปิด");
  assert.equal(days.length, 8, "8 วันเปิด (ข้ามอาทิตย์)");
  assert.equal(days.at(-1).date, "2026-11-26");
  assert.equal(bookingRules.selfBookingAllowed("2026-11-18", "09:30", HOURS, now), false, "เลยเวลาแล้ว");
  assert.equal(bookingRules.selfBookingAllowed("2026-11-19", "18:00", HOURS, now), false, "นอกเวลาเปิด");
  assert.equal(bookingRules.selfBookingAllowed("2026-11-19", "10:15", HOURS, now), false, "ไม่ลงตัว 30 นาที");
  assert.equal(bookingRules.selfBookingAllowed("2026-11-22", "10:00", HOURS, now), false, "วันปิด");
  assert.equal(bookingRules.selfBookingAllowed("2026-11-19", "10:00", HOURS, now), true);
});

test("การ์ดแจ้งผลไม่มีนัด: \"ยังไม่มีนัดฟังผล\" + ปุ่มเลือกวันนัดฟังผล (?book=) · มีนัด: ไม่มีปุ่มเลือกวัน", async () => {
  const next = await initialize(Date.now());
  labs = [item("3001")];
  await store.runLabSync(next);
  const flex = JSON.stringify(pushes()[0].messages);
  assert.match(flex, /ยังไม่มีนัดฟังผล/);
  assert.match(flex, /เลือกวันนัดฟังผล/);
  assert.match(flex, new RegExp(`https://liff\\.line\\.me/2000000000-abcd\\?book=${row("3001").id}`));

  const withAppt = rules.patientNoticeFlex({
    clinic: "ค", patientName: null, showName: false, updated: false, orderDate: null, viewUrl: "v", mineUrl: "m", bookUrl: "b",
    appointment: { id: APPT, appoint_date: "2026-12-01", time_mode: "exact", time_start: "09:30:00", time_end: null, status: "scheduled", purpose_text: "ฟังผล" },
  });
  const s = JSON.stringify(withAppt);
  assert.doesNotMatch(s, /เลือกวันนัดฟังผล|ยังไม่มีนัดฟังผล/);
  assert.match(s, /appt:confirm:/);
});

test("ขอนัดฟังผล: บัญชีที่ไม่ผูก HN ขอไม่ได้ · นอกเวลาเปิดถูกปฏิเสธ · ส่งแล้วเป็นคำขอรอเจ้าหน้าที่ลงนัด · ขอซ้ำอัปเดตอันเดิม", async () => {
  withHours();
  const next = await initialize(Date.now());
  labs = [item("3101")];
  await store.runLabSync(next);
  const id = row("3101").id;

  assert.equal((await postJson(bookingRoute, { id, idToken: "tok-other" })).status, 404, "บัญชีอื่นดูไม่ได้");
  assert.equal((await postJson(requestRoute, { id, idToken: "tok-other", date: "2099-01-01", time: "10:00" })).status, 404, "บัญชีที่ไม่ผูก HN ขอไม่ได้");
  const info = await (await postJson(bookingRoute, { id, idToken: "tok-owner" })).json();
  assert.equal(info.appointment, null);
  assert.equal(info.request, null);
  assert.ok(info.days.length > 0 && info.days.length <= 8);
  const [d1, d2] = [info.days[0], info.days[1]];

  const bad = await postJson(requestRoute, { id, idToken: "tok-owner", date: d1.date, time: "03:00" });
  assert.equal(bad.status, 400, "นอกเวลาเปิด");
  assert.equal((state.tables.bookings ?? []).length, 0);

  const ok = await postJson(requestRoute, { id, idToken: "tok-owner", date: d1.date, time: d1.times[0] });
  assert.equal(ok.status, 200);
  assert.equal(state.tables.bookings.length, 1);
  const b = state.tables.bookings[0];
  assert.equal(b.conversation_id, "conv1");
  assert.equal(b.service, "ฟังผลแล็บ");
  assert.equal(b.status, "ai_confirmed");
  assert.equal(b.name, "สมชาย ใจดี");
  assert.equal(b.date, d1.date);
  const sys = state.tables.messages.filter((m) => m.conversation_id === "conv1" && m.sender_type === "system" && /คนไข้ขอนัดฟังผล/.test(m.body));
  assert.equal(sys.length, 1);
  assert.match(sys[0].body, /รอเจ้าหน้าที่ลงนัด/);

  // ขอซ้ำ: อัปเดตอันเดิม ไม่สร้างใหม่
  await postJson(requestRoute, { id, idToken: "tok-owner", date: d2.date, time: d2.times.at(-1) });
  assert.equal(state.tables.bookings.length, 1);
  assert.equal(state.tables.bookings[0].date, d2.date);
  assert.equal(state.tables.bookings[0].time, d2.times.at(-1));

  // หน้าคนไข้ + หน้าเจ้าหน้าที่เห็นคำขอ
  const v = await (await postJson(viewRoute, { id, idToken: "tok-owner" })).json();
  assert.equal(v.appointment, null);
  assert.equal(v.request.date, d2.date);
  const mine = await (await postJson(mineRoute, { idToken: "tok-owner" })).json();
  assert.equal(mine.results[0].request.date, d2.date);
  const admin = await (await listRoute.GET(new Request("https://app.test/api/lab-results?tab=all"))).json();
  assert.equal(admin.requests["000004714"].conversation_id, "conv1");
  assert.match(admin.requests["000004714"].when, /เวลา/);
});

test("เจ้าหน้าที่ลงนัดจากคำขอ (createAppointment booking_id) แล้วการ์ด/หน้าคนไข้แสดงนัดจริง", async () => {
  withHours();
  const next = await initialize(Date.now());
  labs = [item("3201")];
  await store.runLabSync(next);
  const id = row("3201").id;
  const info = await (await postJson(bookingRoute, { id, idToken: "tok-owner" })).json();
  const d = info.days.find((x) => x.date > info.days[0].date) ?? info.days[0];
  await postJson(requestRoute, { id, idToken: "tok-owner", date: d.date, time: d.times[0] });
  const booking = state.tables.bookings[0];

  await apptStore.createAppointment({
    booking_id: booking.id, conversation_id: "conv1", hn: "4714", patient_name: "สมชาย ใจดี",
    appoint_date: d.date, time_mode: "exact", time_start: d.times[0], purpose_text: "ฟังผลแล็บ",
  }, "agent", { canLink: true });
  assert.equal(state.tables.bookings[0].status, "recorded");

  const v = await (await postJson(viewRoute, { id, idToken: "tok-owner" })).json();
  assert.ok(v.appointment, "หน้าดูผลแสดงนัดจริง");
  assert.match(v.appointment.when, new RegExp(d.times[0]));
  assert.equal(v.request, null);
  const after = await (await postJson(bookingRoute, { id, idToken: "tok-owner" })).json();
  assert.ok(after.appointment);
  assert.deepEqual(after.days, [], "มีนัดแล้วไม่ต้องเลือกวัน");
  assert.equal((await postJson(requestRoute, { id, idToken: "tok-owner", date: d.date, time: d.times[0] })).status, 409, "มีนัดแล้วขอซ้ำไม่ได้");
  const admin = await (await listRoute.GET(new Request("https://app.test/api/lab-results?tab=all"))).json();
  assert.equal(admin.requests["000004714"], undefined);
  assert.ok(admin.appointments["000004714"]);
});

test("ไทม์ไลน์แชท: ลิงก์เจ้าหน้าที่เปิด PDF (ไม่ใช่ลิงก์ LIFF ของคนไข้) + บอกว่ามี/ไม่มีนัดฟังผล", async () => {
  const next = await initialize(Date.now());
  labs = [item("3301")];
  await store.runLabSync(next);
  const m = state.tables.messages.find((x) => x.conversation_id === "conv1" && x.imported_sender_name === rules.LAB_SENDER_NAME);
  assert.match(m.body, new RegExp(`เจ้าหน้าที่เปิดผล: https://docdesk-tau\\.vercel\\.app/api/lab-results/${row("3301").id}/pdf`));
  assert.doesNotMatch(m.body, /liff\.line\.me/);
  assert.match(m.body, /ยังไม่มีนัดฟังผล/);
});

test("แล็บอ่าน HN ได้แต่คนไข้ยังไม่อยู่ใน patients (คนไข้ใหม่): ผูกเลย + สร้างแถวคนไข้", async () => {
  const next = await initialize(Date.now());
  labs = [item("2401", { location_hn: "4823" })];
  await store.runLabSync(next);
  assert.equal(row("2401").match_status, "matched");
  assert.equal(row("2401").patient_id, "000004823");
  assert.ok(state.tables.patients.some((p) => p.hn === "000004823"));
});

// ---------------------------------------------------------------------------
// ภาษาของการ์ดแจ้งผลแล็บ = ภาษาของบัญชี LINE (เหมือนข้อความนัด) · หน้า LIFF อังกฤษเมื่อบัญชีไม่ใช่ไทย
// ---------------------------------------------------------------------------
const ai = await import(fake("ai"));
const apptRules = await import("../src/lib/appointment-rules.ts");
const HEARING = "11111111-2222-4333-8444-666666666666";
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function notifyInLanguage(language, bmlId, { appointment = true } = {}) {
  state.tables.appointment_translations = [];
  state.tables.slip_translations = [];
  state.tables.contacts.find((c) => c.id === "c1").language = language;
  if (appointment) {
    state.tables.appointments.push({ id: HEARING, hn: "000004714", appoint_date: inDays(5), time_mode: "exact", time_start: "10:30:00", time_end: null, status: "scheduled", purpose_text: "ฟังผลแล็บ", telemed_id: null });
  }
  const next = await initialize(Date.now());
  labs = [item(bmlId)];
  const summary = await store.runLabSync(next);
  const toPatient = pushes().find((p) => p.to === LINE_USER);
  assert.ok(toPatient, "ส่งการ์ดถึงคนไข้");
  const msg = (state.tables.messages ?? []).filter((m) => m.conversation_id === "conv1" && m.sender_type === "system").at(-1);
  return { summary, flex: toPatient.messages[0], json: JSON.stringify(toPatient.messages[0]), msg };
}
const buttonLabels = (flex) => (JSON.stringify(flex.contents.footer).match(/"label":"[^"]*"/g) ?? []).map((s) => JSON.parse(`{${s}}`).label);

test("ภาษาการ์ดผลแล็บ: บัญชีไทย = ฉบับไทยเดิมทุกคำ ไม่เรียก AI · ข้อความในแชทเป็นภาษา th", async () => {
  ai.reset();
  const { flex, json, msg } = await notifyInLanguage("th", "901");
  assert.match(json, /ผลแล็บของคุณออกแล้ว/);
  assert.deepEqual(buttonLabels(flex), ["ดูผล", "ดูผลแล็บทั้งหมดของฉัน", "ยืนยันนัด", "ขอเลื่อนนัด"]);
  assert.match(json, /คลินิกทดสอบ/);
  assert.match(flex.altText, /^ผลแล็บของคุณออกแล้ว · นัดฟังผล .* น\.$/);
  assert.equal(ai.calls.chat, 0);
  assert.equal(msg.language, "th");
});

test("ภาษาการ์ดผลแล็บ: บัญชีอังกฤษ = การ์ดอังกฤษ + ชื่อคลินิกอังกฤษ + วันที่อังกฤษ · ไม่เรียก AI · ไทม์ไลน์เจ้าหน้าที่ยังเป็นไทย", async () => {
  ai.reset();
  const { flex, json, msg } = await notifyInLanguage("en", "902");
  assert.match(json, /Your lab results are ready/);
  assert.match(json, /Results appointment/);
  assert.deepEqual(buttonLabels(flex), ["View results", "All my lab results", "Confirm", "Reschedule"]);
  assert.match(json, /HappiWell Medical Clinic/, "ชื่อคลินิกอังกฤษจากตั้งค่านัด");
  assert.doesNotMatch(json, /คลินิกทดสอบ|ผลแล็บ|นัดฟังผล|ยืนยันนัด/, "ไม่มีภาษาไทยในการ์ด");
  assert.match(json, new RegExp(escapeRe(apptRules.englishDate(inDays(5)))));
  assert.match(json, /10:30/);
  assert.match(json, /appt:confirm:11111111-2222-4333-8444-666666666666/, "postback เดิมของระบบนัด");
  assert.match(flex.altText, /^Your lab results are ready · Results appointment: /);
  assert.equal(ai.calls.chat, 0);
  assert.equal(msg.language, "en");
  assert.match(msg.body, /ผลแล็บของคุณออกแล้ว/, "ไทม์ไลน์ในแชทเจ้าหน้าที่เป็นไทย");
});

test("ภาษาการ์ดผลแล็บ: ภาษาอื่น (ja) แปลวลีผ่าน pack ครั้งเดียว · ตัวแปร/ตัวเลขครบ · วลีที่ตัวแปรหายใช้อังกฤษ · ปุ่ม ≤ 20 ตัว", async () => {
  ai.reset();
  const settings = apptRules.normalizeAppointmentSettings({});
  const items = Object.fromEntries([...Object.entries(apptRules.EN_PHRASES), ["template", settings.template_en]].map(([k, v]) => [k, `日本語:${v}`]));
  items["lab.apptLine"] = "日本語 予約"; // {when} หาย → ใช้อังกฤษเฉพาะวลีนี้
  items["lab.view"] = "結果を見る結果を見る結果を見る結果を見る結果"; // ยาวเกิน 20
  ai.replies.next = { items };
  const { flex, json, msg } = await notifyInLanguage("ja", "903");
  assert.equal(ai.calls.chat, 1, "แปลชุดวลีครั้งเดียว");
  assert.match(json, /日本語:Your lab results are ready/);
  assert.match(json, /日本語:Results appointment/);
  assert.ok(buttonLabels(flex).every((l) => [...l].length <= 20), "ปุ่ม LINE ≤ 20 ตัวอักษร");
  assert.equal(buttonLabels(flex)[0], [...items["lab.view"]].slice(0, 20).join(""));
  assert.match(flex.altText, /Results appointment: .*10:30/, "วลีที่ตัวแปรหายใช้อังกฤษ แล้วเติมวันเวลา");
  assert.doesNotMatch(flex.altText, /日本語 予約/);
  assert.equal(msg.language, "ja");
});

test("ภาษาการ์ดผลแล็บ: AI ล่ม = การ์ดอังกฤษ ส่งได้ตามปกติ", async () => {
  ai.reset();
  ai.calls.failNext = new Error("AI down");
  const { summary, json, msg } = await notifyInLanguage("ko", "904", { appointment: false });
  assert.equal(summary.notified, 1, "ไม่กันการส่ง");
  assert.match(json, /Your lab results are ready/);
  assert.match(json, /No results appointment yet/);
  assert.match(json, /Choose a date/, "ไม่มีนัด = ปุ่มเลือกวัน (อังกฤษ)");
  assert.equal(row("904").notify_status, "sent");
  assert.equal(msg.language, "en", "AI ล่ม = เก็บเป็นอังกฤษ");
});

test("patientNoticeText: ไทยเดิม · มี pack = ตามภาษา ลิงก์เติมหลังแปล", () => {
  const base = { clinic: "คลินิก", patientName: null, showName: false, updated: false, orderDate: null, viewUrl: "https://liff/v", mineUrl: "https://liff/m", bookUrl: "https://liff/b", appointment: null };
  assert.equal(rules.patientNoticeText(base), ["ผลแล็บของคุณออกแล้ว", "กดลิงก์เพื่อดูผล (ลิงก์ใช้ได้เฉพาะบัญชี LINE นี้)", "https://liff/v", "ดูผลแล็บทั้งหมดของฉัน: https://liff/m", "คลินิก"].join("\n"));
  const en = rules.patientNoticeText({ ...base, clinic: "HappiWell", updated: true, pack: { lang: "en", phrases: { ...apptRules.EN_PHRASES }, template: "" } });
  assert.equal(en, ["Your lab results were updated", apptRules.EN_PHRASES["lab.updatedHint"], "https://liff/v", "All my lab results: https://liff/m", "HappiWell"].join("\n"));
});

test("หน้า LIFF: บัญชีอังกฤษได้ lang=en + วันนัดอังกฤษ · บัญชีไทยได้ th · หน้าเว็บมีข้อความอังกฤษครบ + บรรทัดใบผลภาษาต้นฉบับ", async () => {
  state.tables.contacts.find((c) => c.id === "c1").language = "en";
  state.tables.appointments.push({ id: HEARING, hn: "000004714", appoint_date: inDays(3), time_mode: "exact", time_start: "09:00:00", time_end: null, status: "scheduled", purpose_text: "ฟังผลแล็บ", telemed_id: null });
  const next = await initialize(Date.now());
  labs = [item("905")];
  await store.runLabSync(next);
  const id = row("905").id;
  const res = await viewRoute.POST(new Request("https://app.test/api/lab-results/view", { method: "POST", body: JSON.stringify({ id, idToken: "tok-owner" }) }));
  const j = await res.json();
  assert.equal(j.lang, "en");
  assert.equal(j.appointment.when, `${apptRules.englishDate(inDays(3))}, 09:00`);
  const mine = await store.patientLabList("tok-owner");
  assert.equal(mine.lang, "en");
  assert.equal(mine.results[0].appointment.when, j.appointment.when);
  state.tables.contacts.find((c) => c.id === "c1").language = "th";
  const th = await store.patientViewLab(id, "tok-owner");
  assert.equal(th.lang, "th");
  assert.match(th.appointment.when, / น\.$/);

  const src = readFileSync("src/app/lab-result/viewer.tsx", "utf8");
  assert.match(src, /This report is issued by the laboratory in its original language\./);
  assert.match(src, /applyLang\(r\.data\.lang\)/, "ใช้ภาษาของบัญชีจาก server");
  assert.match(src, /browserLang\(navigator\.language\)/, "ยังไม่รู้ภาษาบัญชี = ภาษาเบราว์เซอร์");
  const thKeys = src.slice(src.indexOf("  th: {"), src.indexOf("  en: {")).match(/^\s{4}(\w+):|, (\w+):/gm).length;
  const enKeys = src.slice(src.indexOf("  en: {"), src.indexOf("/** ภาษาเริ่มต้น")).match(/^\s{4}(\w+):|, (\w+):/gm).length;
  assert.equal(enKeys, thKeys, "ข้อความอังกฤษครบทุกคำ");
});

// ---------------------------------------------------------------------------
// หน้าผลแล็บเร็วขึ้น: แบ่งหน้า 30 · ตัวกรองแท็บใน SQL · ข้อมูลเสริมรวดเดียวเฉพาะหน้านี้ · การ์ดสรุปนับอย่างเดียว
// ---------------------------------------------------------------------------
const labRow = (i, extra = {}) => ({
  id: `lab-${String(i).padStart(3, "0")}`, bml_id: `p${i}`, ln: `LN${i}`, patient_id: null, patient_name: `คนไข้ ${i}`, location_hn: null,
  order_datetime: new Date(Date.parse("2026-11-01T03:00:00Z") + i * 60_000).toISOString(), created_at: "2026-11-01T03:00:00Z",
  match_status: "matched", notify_status: "sent", first_viewed_at: null, version_number: 1, pdf_path: `lab-results/p${i}/v1.pdf`, view_count: 0, ...extra,
});

test("แท็บกรองใน SQL ให้ผลตรงกับ inLabTab ทุกสถานะ (ไม่ขึ้นกับจำนวนรายการ)", async () => {
  const combos = [];
  let i = 0;
  for (const match_status of ["matched", "unmatched", "manual"]) {
    for (const notify_status of ["pending", "sent", "unreachable", "failed", "skipped"]) {
      for (const first_viewed_at of [null, "2026-11-02T00:00:00Z"]) combos.push(labRow(++i, { match_status, notify_status, first_viewed_at }));
    }
  }
  state.tables.lab_results = combos;
  for (const t of rules.LAB_TABS) {
    const want = combos.filter((r) => rules.inLabTab(r, t.key)).map((r) => r.id).sort();
    const got = [];
    for (let page = 1; ; page++) {
      const p = await store.listLabResults({ tab: t.key, page });
      got.push(...p.rows.map((r) => r.id));
      assert.equal(p.total, want.length, `${t.key}: total`);
      if (page >= rules.lastLabPage(p.total)) break;
    }
    assert.deepEqual(got.sort(), want, `แท็บ ${t.key}`);
  }
  assert.deepEqual(rules.labTabFilters("all"), []);
  assert.deepEqual(rules.labTabFilters("unviewed"), [{ col: "notify_status", eq: "sent" }, { col: "first_viewed_at", isNull: true }]);
});

test("แบ่งหน้า 14 รายการ: หน้าแรก · หน้าสุดท้าย · ขอเกินหน้าสุดท้าย = หน้าสุดท้าย · ไม่มีรายการ · ลำดับคงที่เมื่อเวลาเท่ากัน", async () => {
  state.tables.lab_results = Array.from({ length: 65 }, (_, k) => labRow(k + 1));
  const p1 = await store.listLabResults({ page: 1 });
  assert.equal(p1.rows.length, 14);
  assert.equal(p1.total, 65);
  assert.equal(p1.pageSize, 14);
  assert.equal(p1.rows[0].id, "lab-065", "ล่าสุดก่อน");
  const p5 = await store.listLabResults({ page: 5 });
  assert.deepEqual([p5.page, p5.rows.length, p5.rows.at(-1).id], [5, 9, "lab-001"], "65 = 14×4 + 9");
  const beyond = await store.listLabResults({ page: 9 });
  assert.deepEqual([beyond.page, beyond.rows.length], [5, 9], "ขอเกิน = หน้าสุดท้าย ไม่ใช่หน้าว่าง");
  for (const bad of [0, -2, Number.NaN, 1.7]) assert.equal((await store.listLabResults({ page: bad })).page, 1);
  const all = [];
  for (const page of [1, 2, 3, 4, 5]) all.push(...(await store.listLabResults({ page })).rows.map((r) => r.id));
  assert.equal(new Set(all).size, 65, "ไม่มีแถวซ้ำ/หายระหว่างหน้า");
  // เวลาสั่งตรวจเท่ากันทั้งหมด: id ต่อท้ายทำให้ลำดับคงที่
  state.tables.lab_results = Array.from({ length: 40 }, (_, k) => labRow(k + 1, { order_datetime: "2026-11-01T03:00:00.000Z" }));
  const a = [...(await store.listLabResults({ page: 1 })).rows, ...(await store.listLabResults({ page: 2 })).rows, ...(await store.listLabResults({ page: 3 })).rows].map((r) => r.id);
  assert.equal(new Set(a).size, 40);
  state.tables.lab_results = [];
  assert.deepEqual(await store.listLabResults({ page: 4 }), { rows: [], total: 0, page: 1, pageSize: 14 }, "ไม่มีรายการ = หน้า 1 จาก 1");
  // เจอบน production: 14 รายการ ขอหน้า 2 → PostgREST ตอบ range ไม่ได้ (ไม่มี count) ต้องได้หน้าสุดท้ายพร้อมจำนวนจริง
  state.tables.lab_results = Array.from({ length: 14 }, (_, k) => labRow(k + 1));
  assert.deepEqual((({ page, total, rows }) => [page, total, rows.length])(await store.listLabResults({ page: 2 })), [1, 14, 14]);
  assert.equal(rules.lastLabPage(0), 1);
  assert.equal(rules.lastLabPage(28), 2);
  assert.equal(rules.lastLabPage(29), 3);
});

test("แผงขวาของแชท: ไม่แบ่งหน้า แต่ไม่เกิน 50 รายการ", async () => {
  state.tables.lab_results = Array.from({ length: 55 }, (_, k) => labRow(k + 1, { patient_id: "000004714" }));
  const p = await store.listLabResults({ conversationId: "conv1" });
  assert.equal(p.rows.length, 50);
  assert.equal(p.total, 55);
});

test("lineReadyHns รวดเดียวทุก HN: ผูก LINE ส่งได้ = true · บล็อก / เก็บถาวร / FB / ไม่ผูก = false", async () => {
  state.tables.contacts.push(
    { id: "c-block", channel_id: "line", external_id: "Ublock", language: "th", line_unfollowed_at: "2026-11-01T00:00:00Z" },
    { id: "c-arch", channel_id: "line", external_id: "Uarch", language: "th" },
  );
  state.tables.conversations.push(
    { id: "conv-block", contact_id: "c-block", channel_id: "line", status: "open", tags: [], archived: false },
    { id: "conv-arch", contact_id: "c-arch", channel_id: "line", status: "open", tags: [], archived: true },
  );
  state.tables.patient_links.push(
    { conversation_id: "conv-block", hn: "000000111", role: "patient", linked_at: nextTime() },
    { conversation_id: "conv-arch", hn: "222", role: "patient", linked_at: nextTime() },
    // HN เดียวกัน ผูกได้หลายแชท: แชทหนึ่งส่งได้ = ส่งได้
    { conversation_id: "conv1", hn: "333", role: "relative", linked_at: nextTime() },
    { conversation_id: "conv-block", hn: "000000333", role: "patient", linked_at: nextTime() },
  );
  const ready = await store.lineReadyHns(["000004714", "000000111", "000000222", "000000777", "000000333", "000000999", null, "000004714"]);
  assert.deepEqual(ready, { "000004714": true, "000000111": false, "000000222": false, "000000777": false, "000000333": true, "000000999": false });
  const src = readFileSync("src/lib/lab-results-store.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function lineReadyHns"), src.indexOf("export async function labSyncStatus"));
  assert.doesNotMatch(fn, /for \(const hn of|lineTargetsOf\(/, "ไม่วนถามทีละ HN");
  assert.deepEqual(await store.lineReadyHns([]), {});
});

test("hearingRequestsByHn รวดเดียว: คำขอล่าสุดของแต่ละ HN จากทุกแชทที่ผูก · ไม่วนทีละ HN", async () => {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  state.tables.bookings = [
    { id: "b-old", conversation_id: "conv1", service: rules.HEARING_SERVICE, status: "ai_confirmed", date: tomorrow, time: "09:00:00", created_at: "2026-11-01T01:00:00Z" },
    { id: "b-new", conversation_id: "conv1", service: rules.HEARING_SERVICE, status: "ai_confirmed", date: tomorrow, time: "10:30:00", created_at: "2026-11-02T01:00:00Z" },
    { id: "b-other", conversation_id: "conv1", service: "ตรวจเลือด", status: "ai_confirmed", date: tomorrow, time: "11:00:00", created_at: "2026-11-03T01:00:00Z" },
  ];
  const out = await store.hearingRequestsByHn(["000004714", "000000777", null]);
  assert.deepEqual(Object.keys(out), ["000004714"]);
  assert.equal(out["000004714"].id, "b-new");
  assert.equal(out["000004714"].time, "10:30");
  assert.match(out["000004714"].when, /10:30 น\./);
  const src = readFileSync("src/lib/lab-results-store.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function hearingRequestsByHn"), src.indexOf("/** ผลนี้ + แชท LINE"));
  assert.doesNotMatch(fn, /for \(const hn of \[|pendingHearingRequest\(/);
});

test("การ์ดสรุปนับด้วย count อย่างเดียว ไม่ดึงแถว · ผลเก่า (skipped) ไม่นับเป็นผลใหม่วันนี้", async () => {
  const today = new Date().toISOString();
  state.tables.lab_results = [
    labRow(1, { created_at: today }), labRow(2, { created_at: today, notify_status: "skipped" }), labRow(3, { created_at: "2026-01-01T00:00:00Z", match_status: "unmatched", notify_status: "pending" }),
    labRow(4, { created_at: "2026-01-01T00:00:00Z", first_viewed_at: "2026-01-02T00:00:00Z" }),
  ];
  assert.deepEqual(await store.labResultSummary(), { today: 1, unmatched: 1, unviewed: 1 }, "unviewed = แจ้งแล้วและยังไม่เปิด (แถว 1 เท่านั้น)");
  const src = readFileSync("src/lib/lab-results-store.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function labResultSummary"), src.indexOf("/** badge เมนูซ้าย"));
  assert.match(fn, /head: true/);
  assert.equal((fn.match(/count: "exact"/g) ?? []).length, 1);
});

test("API รายการ: ?page= · คืน total/page/pageSize · ข้อมูลเสริมเฉพาะแถวในหน้า · Server-Timing", async () => {
  state.tables.lab_results = Array.from({ length: 15 }, (_, k) => labRow(k + 1));
  const get = async (qs) => listRoute.GET(new Request(`https://app.test/api/lab-results?${qs}`));
  const res = await get("page=2");
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual([j.page, j.pageSize, j.total, j.results.length], [2, 14, 15, 1]);
  assert.match(res.headers.get("server-timing") ?? "", /list;dur=[\d.]+.*extra;dur=/);
  const route = readFileSync("src/app/api/lab-results/route.ts", "utf8");
  assert.match(route, /const results = list\.rows;/, "ข้อมูลเสริมจากแถวของหน้านี้เท่านั้น");
});

test("หน้าเว็บ: ตัวแบ่งหน้าใต้ตาราง (จาง ไม่ซ่อน) · เปลี่ยนตัวกรองกลับหน้า 1 · ค้นหา debounce 300 ms · ยกเลิกคำขอเก่า · แถวเดิมยังอยู่ระหว่างโหลด", () => {
  const ui = readFileSync("src/app/(staff)/lab-results/lab-results-client.tsx", "utf8");
  assert.match(ui, /‹ ก่อนหน้า/);
  assert.match(ui, /หน้า \{page\} \/ \{last\} \(ทั้งหมด \{total\} รายการ\)/);
  assert.match(ui, /ถัดไป ›/);
  assert.match(ui, /disabled=\{page <= 1 \|\| loading\}/);
  assert.match(ui, /disabled=\{page >= last \|\| loading\}/);
  assert.doesNotMatch(ui, /\{(total|page) > 1 && <LabPager/, "ตัวแบ่งหน้าแสดงเสมอ");
  assert.match(ui, /useEffect\(\(\) => \{ setPage\(1\); \}, \[tab, qDebounced, from, to, onlyId\]\);/);
  assert.match(ui, /setTimeout\(\(\) => setQDebounced\(q\), 300\)/);
  assert.match(ui, /abortRef\.current\?\.abort\(\);\s*const ctrl = new AbortController\(\);/);
  assert.match(ui, /signal: ctrl\.signal/);
  assert.doesNotMatch(ui, /setRows\(\[\]\)/, "ไม่ล้างแถวก่อนโหลด (ไม่กระพริบว่าง)");
  const css = readFileSync("src/app/globals.css", "utf8");
  assert.match(css, /\.lab-pager \{ position: sticky; bottom: 0;/);
  assert.match(css, /\.lab-pager \.btn:disabled \{ opacity: \.45;/);
});

test("migration 067: index ของแท็บที่กรองใน SQL", () => {
  const sql = readFileSync("supabase/migrations/067_lab_results_paging.sql", "utf8");
  assert.match(sql, /lab_results \(order_datetime desc\) where match_status = 'unmatched'/);
  assert.match(sql, /where notify_status = 'sent' and first_viewed_at is null/);
  assert.match(sql, /lab_results \(notify_status, order_datetime desc\)/);
});

test("ลำดับหน้าชื่อในหน้าผลแล็บ: นับต่อกันทุกหน้า (หน้า 2 เริ่มที่ 15) ทั้งตารางและมือถือ", () => {
  const ui = readFileSync("src/app/(staff)/lab-results/lab-results-client.tsx", "utf8");
  assert.match(ui, /setOffset\(\(\(typeof j\.page === "number" \? j\.page : page\) - 1\) \* \(typeof j\.pageSize === "number" \? j\.pageSize : LAB_PAGE_SIZE\)\)/);
  assert.match(ui, /<th scope="col" className="lab-no-col">#<\/th><th scope="col">คนไข้<\/th>/, "คอลัมน์ลำดับอยู่หน้าคนไข้");
  assert.match(ui, /<td className="lab-no-col lab-no">\{offset \+ i \+ 1\}<\/td>\s*<td className="lab-who">/);
  assert.match(ui, /<span className="lab-no">\{offset \+ i \+ 1\}\.<\/span> \{r\.patient_name/, "มือถือ: เลขหน้าชื่อ");
  assert.equal(rules.LAB_PAGE_SIZE, 14);
});
