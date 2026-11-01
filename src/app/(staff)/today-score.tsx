"use client";

import { useEffect, useMemo, useState } from "react";
import { periodStart } from "@/lib/scoring";
import { supabaseBrowser } from "@/lib/supabase/browser";

const POLL_MS = 60_000;

/** RLS ให้เห็นเฉพาะแถวของตัวเอง ยกเว้น admin จึงต้องกรองตาม id ด้วย */
export function TodayScore({ meId }: { meId: string }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [score, setScore] = useState<number | null>(null);

  useEffect(() => {
    const load = async () => {
      const from = periodStart("day");
      const [{ data: speed }, { data: quality }] = await Promise.all([
        sb.from("response_events").select("points").eq("replied_by", meId).gte("replied_at", from),
        sb.from("score_events").select("points").eq("staff_id", meId).gte("created_at", from),
      ]);
      const sum = [...(speed ?? []), ...(quality ?? [])].reduce((n, r) => n + Number(r.points), 0);
      setScore(Math.round(sum * 100) / 100);
    };
    load();
    const poll = setInterval(load, POLL_MS);
    return () => clearInterval(poll);
  }, [sb, meId]);

  return <div className="today-score">คะแนนวันนี้ <b>{score ?? "–"}</b></div>;
}
