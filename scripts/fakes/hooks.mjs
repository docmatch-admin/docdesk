// ให้เทสต์ import โค้ดจริงใน src ได้ โดยแทนเฉพาะ OpenAI กับฐานข้อมูล
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const fake = (name) => new URL(`./${name}.mjs`, import.meta.url).href;

const SRC = new URL("../../src/", import.meta.url);

function resolveFile(base) {
  const file = pathToFileURL(`${base}.ts`).href;
  if (file.endsWith("/lib/ai.ts")) return fake("ai");
  if (file.endsWith("/lib/supabase/admin.ts")) return fake("admin");
  if (file.endsWith("/lib/supabase/server.ts")) return fake("server");
  if (existsSync(`${base}.ts`)) return file;
  if (existsSync(`${base}/index.ts`)) return pathToFileURL(`${base}/index.ts`).href;
  return null;
}

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/server") return { url: fake("next-server"), shortCircuit: true };
    let base = null;
    if (specifier.startsWith("@/")) base = fileURLToPath(new URL(specifier.slice(2), SRC));
    else if (specifier.startsWith(".") && /\/src\/(lib|app)\//.test(context.parentURL ?? "")) base = fileURLToPath(new URL(specifier, context.parentURL));
    const url = base && resolveFile(base);
    return url ? { url, shortCircuit: true } : next(specifier, context);
  },
});
