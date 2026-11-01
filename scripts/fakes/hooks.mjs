// ให้เทสต์ import โค้ดจริงใน src/lib ได้ โดยแทนเฉพาะ OpenAI กับฐานข้อมูล
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const fake = (name) => new URL(`./${name}.mjs`, import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL?.includes("/src/lib/")) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      const file = pathToFileURL(`${base}.ts`).href;
      if (file.endsWith("/lib/ai.ts")) return { url: fake("ai"), shortCircuit: true };
      if (file.endsWith("/lib/supabase/admin.ts")) return { url: fake("admin"), shortCircuit: true };
      if (existsSync(`${base}.ts`)) return { url: file, shortCircuit: true };
      if (existsSync(`${base}/index.ts`)) return { url: pathToFileURL(`${base}/index.ts`).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
