"use client";

import { useEffect, useState } from "react";
import { quotaBanner, type QuotaState } from "@/lib/line-usage-rules";

const POLL_MS = 10 * 60_000;

/** แถบเหลือง (ใช้ ≥ 80%) / แดง (หมด) บนทุกหน้า server อ่านจาก LINE อย่างมากชั่วโมงละครั้ง */
export function QuotaBanner() {
  const [state, setState] = useState<QuotaState | null>(null);

  useEffect(() => {
    const load = () => fetch("/api/line/quota-state").then(async (r) => { if (r.ok) setState(await r.json()); }).catch(() => {});
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, []);

  const b = state ? quotaBanner(state) : null;
  if (!b) return null;
  return <div className={`quota-banner ${b.tone}`} role={b.tone === "out" ? "alert" : "status"}>{b.tone === "out" ? "⛔" : "⚠️"} {b.text}</div>;
}
