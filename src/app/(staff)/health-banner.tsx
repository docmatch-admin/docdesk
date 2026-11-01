"use client";

import { useEffect, useMemo, useState } from "react";
import { healthProblems, type HealthRow } from "@/lib/health-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";

const POLL_MS = 60_000;

/** แถบแดงด้านบนทุกหน้า */
export function HealthBanner() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    const load = async () => {
      const { data } = await sb.from("system_health").select("check_name, ok, detail, checked_at");
      setProblems(healthProblems((data ?? []) as HealthRow[]));
    };
    load();
    const poll = setInterval(load, POLL_MS);
    return () => clearInterval(poll);
  }, [sb]);

  if (!problems.length) return null;
  return <div className="health-banner" role="alert">⚠️ ระบบผิดปกติ: {problems.join(" · ")}</div>;
}
