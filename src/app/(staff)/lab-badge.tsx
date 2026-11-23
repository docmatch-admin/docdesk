"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

/** badge "รอจับคู่" ที่เมนูผลแล็บ: อัปเดตเองเมื่อตาราง lab_results เปลี่ยน · dot = จุดแดงบนปุ่มเมนูมือถือ */
export function LabBadge({ initial, channel = "lab-badge", dot = false }: { initial: number; channel?: string; dot?: boolean }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [n, setN] = useState(initial);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        fetch("/api/lab-results?counts=1").then((r) => (r.ok ? r.json() : null)).then((j) => typeof j?.unmatched === "number" && setN(j.unmatched)).catch(() => {});
      }, 500);
    };
    const ch = sb.channel(channel).on("postgres_changes", { event: "*", schema: "public", table: "lab_results" }, refresh).subscribe();
    const tick = setInterval(refresh, 10 * 60_000);
    return () => { sb.removeChannel(ch); clearInterval(tick); if (timer) clearTimeout(timer); };
  }, [sb, channel]);

  if (!n) return null;
  if (dot) return <span className="mnav-dot" aria-label={`ผลแล็บรอจับคู่ ${n}`} title={`ผลแล็บรอจับคู่ ${n}`} />;
  return <span className="badge nav-count lab-badge" aria-label={`ผลแล็บรอจับคู่ ${n}`} title={`รอจับคู่ ${n}`}>{n}</span>;
}
