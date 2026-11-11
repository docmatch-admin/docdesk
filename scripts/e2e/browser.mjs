// เครื่องมือ e2e ขนาดเล็ก (ไม่มี dependency เพิ่ม): รวมโค้ดหน้าเว็บจริงเป็นไฟล์เดียว แล้วเปิดใน Chrome headless ผ่าน DevTools Protocol
// - โค้ดของแอป (.ts/.tsx) แปลงด้วย typescript ที่มีอยู่แล้ว · React/ReactDOM ใช้ไฟล์จริงจาก node_modules
// - stubs: แทนโมดูลที่ต้องใช้ server/Next runtime (เช่น next/navigation, supabase browser client)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "../..");
const require = createRequire(join(ROOT, "package.json"));
const ts = require("typescript");
export const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
export const chromeAvailable = () => existsSync(CHROME);

/** stubs: ชื่อโมดูล → โค้ด CommonJS */
export function bundle(entryCode, stubs = {}) {
  const modules = new Map();
  const tryFile = (p) => {
    for (const c of [p, `${p}.ts`, `${p}.tsx`, `${p}.js`, join(p, "index.ts"), join(p, "index.tsx"), join(p, "index.js")]) if (existsSync(c) && !c.endsWith("\\") && !c.endsWith("/") && !isDir(c)) return c;
    return null;
  };
  const isDir = (p) => { try { return require("node:fs").statSync(p).isDirectory(); } catch { return false; } };
  const resolveId = (spec, from) => {
    if (stubs[spec] !== undefined) return `stub:${spec}`;
    if (spec.startsWith("@/")) return tryFile(join(ROOT, "src", spec.slice(2)));
    if (spec.startsWith(".")) return tryFile(resolve(dirname(from), spec));
    return createRequire(from.startsWith("stub:") || from === "entry" ? join(ROOT, "package.json") : from).resolve(spec);
  };
  const add = (id, from) => {
    if (modules.has(id)) return;
    let code;
    if (id === "entry") code = transpile(entryCode, "entry.tsx");
    else if (id.startsWith("stub:")) code = stubs[id.slice(5)];
    else if (/\.(ts|tsx)$/.test(id)) code = transpile(readFileSync(id, "utf8"), id);
    else code = readFileSync(id, "utf8");
    const deps = {};
    modules.set(id, { code, deps });
    for (const m of code.matchAll(/require\((["'])([^"']+)\1\)/g)) {
      const spec = m[2];
      const target = resolveId(spec, id === "entry" ? join(ROOT, "src", "entry.tsx") : id);
      if (!target) throw new Error(`resolve ${spec} from ${id}`);
      deps[spec] = target;
      add(target, id);
    }
  };
  add("entry", "entry");
  const ids = [...modules.keys()];
  const idx = new Map(ids.map((k, i) => [k, i]));
  return `(function(){var process={env:{NODE_ENV:"production"}};var defs=[${ids.map((k) => {
    const m = modules.get(k);
    const map = JSON.stringify(Object.fromEntries(Object.entries(m.deps).map(([s, t]) => [s, idx.get(t)])));
    return `[function(module,exports,require){${m.code}\n},${map}]`;
  }).join(",")}];var cache={};function load(i){if(cache[i])return cache[i].exports;var module={exports:{}};cache[i]=module;var d=defs[i];d[0](module,module.exports,function(s){if(!(s in d[1]))throw new Error("missing "+s);return load(d[1][s]);});return module.exports;}load(0);})();`;
}

function transpile(src, file) {
  return ts.transpileModule(src, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
}

/** เปิดหน้า HTML ใน Chrome headless คืนตัวช่วยสั่งงานผ่าน DevTools Protocol */
export async function openPage(html, { width = 1280, height = 900 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "docdesk-e2e-"));
  const file = join(dir, "index.html");
  writeFileSync(file, html);
  const port = 9500 + Math.floor(Math.random() * 400);
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, "profile")}`, "about:blank"], { stdio: "ignore" });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch { /* ยังไม่พร้อม */ }
  }
  if (!target) { chrome.kill(); throw new Error("Chrome ไม่เปิด"); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const logs = [];
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (d.method === "Runtime.consoleAPICalled") logs.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
    if (d.method === "Runtime.exceptionThrown") logs.push(`EXCEPTION ${d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text}`);
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const my = ++id;
    const on = (m) => { const d = JSON.parse(m.data); if (d.id === my) { ws.removeEventListener("message", on); d.error ? rej(new Error(d.error.message)) : res(d.result); } };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: pathToFileURL(file).href });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = await evaluate(expression).catch(() => null);
      if (v) return v;
      await sleep(50);
    }
    throw new Error(`รอไม่สำเร็จ: ${expression}\n${logs.join("\n")}`);
  };
  /** คลิกด้วยเมาส์จริงที่กึ่งกลางของ element แรกที่ตรง selector */
  const click = async (selector) => {
    const box = await waitFor(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
  };
  /** พิมพ์ข้อความลงช่องที่โฟกัสอยู่ (เหมือนผู้ใช้พิมพ์) */
  const type = async (selector, text) => {
    await click(selector);
    await send("Input.insertText", { text });
  };
  const close = () => { try { ws.close(); } catch { /* ปิดแล้ว */ } chrome.kill(); };
  return { evaluate, waitFor, click, type, close, logs, send };
}
