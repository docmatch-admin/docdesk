"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

type Counts = { mustCall: number; reschedule: number; total: number };

/** badge "ต้องโทร + ขอเลื่อน" ที่เมนู layout ไม่วาดใหม่ตอนเปลี่ยนหน้า จึงอัปเดตเองเมื่อนัดเปลี่ยน */
export function AppointmentBadge({ initial }: { initial: Counts }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [c, setC] = useState(initial);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      // รวมหลายการเปลี่ยนแปลงติดกันเป็นครั้งเดียว
      timer = setTimeout(() => {
        fetch("/api/appointments?counts=1").then((r) => (r.ok ? r.json() : null)).then((j) => j?.counts && setC(j.counts)).catch(() => {});
      }, 500);
    };
    const ch = sb.channel("appointment-badge")
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments" }, refresh)
      .subscribe();
    // วันเปลี่ยน รายการต้องโทรเปลี่ยนแม้ไม่มีใครแก้นัด
    const tick = setInterval(refresh, 10 * 60_000);
    return () => { sb.removeChannel(ch); clearInterval(tick); if (timer) clearTimeout(timer); };
  }, [sb]);

  if (!c.total) return null;
  return <span className="badge red nav-count" aria-label={`ต้องโทร ${c.mustCall} ขอเลื่อน ${c.reschedule}`} title={`ต้องโทร ${c.mustCall} · ขอเลื่อน ${c.reschedule}`}>{c.total}</span>;
}
