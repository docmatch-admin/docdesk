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

let labs, pdfVersion, outbound, loginCount, listCalls, labStatus;
const item = (id, extra = {}) => ({
  id, ln: `LN${id}`, lis_ln: null, hn: "BML1", location_hn: "4714", location_hn_extraction_status: "ok",
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
    appointments: [], lab_results: [], line_sends: [],
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

test("รอบแรก: เก็บผลที่มีอยู่แล้ว + PDF แต่ไม่แจ้งคนไข้/ทีม · เรียกซ้ำภายใน 15 นาทีไม่แตะระบบแล็บ", async () => {
  labs = [item("101"), item("102", { location_hn: "", location_hn_extraction_status: "failed" })];
  const now = Date.now();
  await initialize(now);
  assert.equal(state.tables.lab_results.length, 2);
  assert.equal(row("101").notify_status, "skipped");
  assert.equal(row("101").match_status, "matched");
  assert.equal(row("101").patient_id, "000004714");
  assert.equal(row("102").match_status, "unmatched");
  assert.equal(row("101").pdf_path, "101/v1.pdf");
  assert.ok(state.files[rules.LAB_BUCKET].has("101/v1.pdf"));
  assert.equal(pushes().length, 0);

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
  assert.match(cron, /'0 6-11 \* \* \*'/);
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
