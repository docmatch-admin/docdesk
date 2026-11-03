// ทดสอบการดึงเนื้อหาหน้าเว็บและบทความให้ AI: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const {
  applyWebsitePages, chunkText, findArticleSlugs, htmlToText, parseArticle, parseHomepage, syncWebsitePages, PAGE_SOURCE,
} = await import("../src/lib/website-pages.ts");

const HOME = `<!doctype html><html><head><style>.x{}</style><script>var a="<section>"</script></head><body>
<nav><a href="/">หน้าแรก</a></nav>
<section class="hero"><h1>หมอใกล้บ้าน ที่ดูแลคุณ</h1><p>ตรวจรักษาโรคทั่วไป รับสิทธิบัตรทอง 30 บาท &amp; ประกันสังคม</p></section>
<section id="prices"><h2>ราคาวัคซีน</h2><p>ไข้หวัดใหญ่ 390 บาท</p></section>
<section id="coverage"><h2>เลือกใช้สิทธิที่คุณมีได้ทันที</h2><ul><li>บัตรทอง 30 บาท</li><li>รักษาฟรีตามสิทธิหลักประกันสุขภาพแห่งชาติ</li></ul></section>
<section id="news"><h2>ข่าว</h2><a href="/articles/nhso-quota-cut-2569">อ่าน</a><a href="https://happiwellclinic.com/articles/mmr-vs-proquad/">อ่าน</a></section>
<section id="empty"><h2>ว่าง</h2></section>
<footer>© 2026</footer></body></html>`;
const ARTICLE = `<html><body><header>เมนู</header><main><a href="/articles">← กลับไปหน้าข่าวสารทั้งหมด</a><article>
<h1>สปสช. ตัดโควตา</h1><p>เผยแพร่เมื่อ 2 สิงหาคม 2569</p><p>ถ้าคุณใช้สิทธิบัตรทองที่คลินิกใกล้บ้านเป็นประจำ เรื่องนี้กระทบคุณโดยตรง</p></article></main></body></html>`;

beforeEach(() => {
  reset();
  resetDb({ knowledge_items: [{ id: "price-1", source: "website", website_slug: "flu", category: "วัคซีน", title: "ไข้หวัดใหญ่", content: "390 บาท", active: true }] });
});

test("htmlToText: ตัด script/style/nav/footer ถอด entity แยกบรรทัด", () => {
  const t = htmlToText(HOME);
  assert.ok(!t.includes("var a") && !t.includes(".x{}") && !t.includes("© 2026") && !t.includes("หน้าแรก"));
  assert.match(t, /บัตรทอง 30 บาท & ประกันสังคม/);
  assert.ok(t.split("\n").includes("รักษาฟรีตามสิทธิหลักประกันสุขภาพแห่งชาติ"));
});

test("parseHomepage: แต่ละ section ที่มีหัวข้อ ข้ามราคา/ข่าว/ส่วนว่าง", () => {
  const chunks = parseHomepage(HOME);
  assert.deepEqual(chunks.map((c) => c.slug), ["page:home:section-1", "page:home:coverage"]);
  const coverage = chunks.find((c) => c.slug === "page:home:coverage");
  assert.equal(coverage.title, "เลือกใช้สิทธิที่คุณมีได้ทันที");
  assert.equal(coverage.category, "หน้าเว็บไซต์");
  assert.match(coverage.content, /รักษาฟรีตามสิทธิ/);
});

test("findArticleSlugs และ parseArticle: ใช้ตัวบทความ ตัดลิงก์กลับ", () => {
  assert.deepEqual(findArticleSlugs(HOME), ["nhso-quota-cut-2569", "mmr-vs-proquad"]);
  const [a] = parseArticle("nhso-quota-cut-2569", ARTICLE);
  assert.equal(a.slug, "article:nhso-quota-cut-2569");
  assert.equal(a.title, "สปสช. ตัดโควตา");
  assert.equal(a.category, "บทความเว็บไซต์");
  assert.ok(!a.content.includes("กลับไปหน้าข่าวสาร") && !a.content.includes("เมนู"));
  assert.match(a.content, /กระทบคุณโดยตรง/);
});

test("chunkText: แบ่งตามบรรทัด ไม่เกินขนาด และบรรทัดยาวถูกตัด", () => {
  const parts = chunkText(["ก".repeat(900), "ข".repeat(900), "ค".repeat(3200)].join("\n"), 1500);
  assert.ok(parts.every((p) => p.length <= 1500));
  assert.equal(parts.join("").replace(/\n/g, "").length, 900 + 900 + 3200);
  const long = parseArticle("long", `<article><h1>ยาว</h1><p>${"ง".repeat(4000)}</p></article>`);
  assert.equal(long.length, 3);
  assert.equal(long[1].title, "ยาว (2/3)");
  assert.equal(long[1].slug, "article:long:2");
});

const chunk = (slug, content = `เนื้อหา ${slug}`) => ({ slug, category: "หน้าเว็บไซต์", title: slug, content });
const pages = () => state.tables.knowledge_items.filter((k) => k.source === PAGE_SOURCE);

test("applyWebsitePages: เพิ่มใหม่ ฝังเฉพาะที่เปลี่ยน ปิดที่หาย ไม่แตะราคาจากเว็บ", async () => {
  await applyWebsitePages([chunk("a"), chunk("b"), chunk("c"), chunk("d")]);
  assert.equal(pages().length, 4);
  assert.equal(calls.embed, 4);
  assert.ok(pages().every((p) => p.active && p.embedding));

  const r = await applyWebsitePages([chunk("a"), chunk("b", "แก้แล้ว"), chunk("c")]);
  assert.equal(calls.embed, 5, "ฝังเฉพาะ b");
  assert.deepEqual(r, { count: 3, changed: 1, hidden: 1 });
  assert.equal(pages().find((p) => p.website_slug === "d").active, false);
  assert.equal(state.tables.knowledge_items.find((k) => k.id === "price-1").active, true, "ราคาจากเว็บไม่ถูกปิด");

  await applyWebsitePages([chunk("a"), chunk("b", "แก้แล้ว"), chunk("c"), chunk("d")]);
  assert.equal(pages().find((p) => p.website_slug === "d").active, true, "กลับมาบนเว็บแล้วเปิดใหม่");
});

test("applyWebsitePages: หัวข้อหายเกินครึ่ง (เว็บเปลี่ยนโครงสร้าง) ไม่ปิดของเดิม", async () => {
  await applyWebsitePages([chunk("a"), chunk("b"), chunk("c"), chunk("d"), chunk("e")]);
  const r = await applyWebsitePages([chunk("a")]);
  assert.equal(r.hidden, 0);
  assert.equal(pages().filter((p) => p.active).length, 5);
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("syncWebsitePages: ดึงหน้าแรก หน้ารวม และบทความ บทความที่เปิดไม่ได้ข้ามไป", async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url); seen.push(u);
    if (u.endsWith("/articles/mmr-vs-proquad")) return new Response("gone", { status: 404 });
    if (u.includes("/articles/")) return new Response(ARTICLE, { status: 200 });
    if (u.endsWith("/articles")) return new Response("<html></html>", { status: 200 });
    return new Response(HOME, { status: 200 });
  };
  const r = await syncWebsitePages();
  assert.equal(r.count, 3);
  assert.ok(seen[0].endsWith("happiwellclinic.com/"));
  assert.deepEqual(pages().map((p) => p.website_slug).sort(), ["article:nhso-quota-cut-2569", "page:home:coverage", "page:home:section-1"]);
});

test("syncWebsitePages: เว็บล่มหรือไม่มีเนื้อหา โยน error และไม่ปิดของเดิม", async () => {
  await applyWebsitePages([chunk("a")]);
  globalThis.fetch = async () => new Response("down", { status: 503 });
  await assert.rejects(syncWebsitePages(), /ไม่สำเร็จ/);
  globalThis.fetch = async () => new Response("<html><body>ไม่มี section</body></html>", { status: 200 });
  await assert.rejects(syncWebsitePages(), /ไม่พบเนื้อหา/);
  assert.equal(pages()[0].active, true);
});
