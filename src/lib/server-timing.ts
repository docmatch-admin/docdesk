/**
 * Server-Timing header: ดูเวลาแต่ละขั้นของ API ได้ใน DevTools → Network → Timing
 *   const t = serverTiming();
 *   const x = await t.time("auth", requireStaff());
 *   return NextResponse.json(body, { headers: t.headers() });
 */
export function serverTiming() {
  const start = performance.now();
  const parts: string[] = [];
  const name = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    async time<T>(label: string, work: Promise<T> | (() => Promise<T>)): Promise<T> {
      const t0 = performance.now();
      try {
        return await (typeof work === "function" ? work() : work);
      } finally {
        parts.push(`${name(label)};dur=${(performance.now() - t0).toFixed(1)}`);
      }
    },
    header(): string {
      return [...parts, `total;dur=${(performance.now() - start).toFixed(1)}`].join(", ");
    },
    headers(extra: Record<string, string> = {}): Record<string, string> {
      return { "Cache-Control": "no-store", "Server-Timing": this.header(), ...extra };
    },
  };
}
