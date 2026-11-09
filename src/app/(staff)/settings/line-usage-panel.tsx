"use client";

import { useEffect, useState } from "react";
import { CardHead, useTabAlert } from "./settings-save";
import { LINE_KIND_LABEL, LINE_KINDS, quotaForecast, type LineUsageSummary } from "@/lib/line-usage-rules";

export type Usage = LineUsageSummary & { quota: { type: string; limit: number | null; used: number | null; error: string | null } };

const n = (v: number) => v.toLocaleString("th-TH");

/** หน้าตั้งค่า: การใช้ข้อความ LINE เดือนนี้ (push นับโควตา reply ฟรี) */
export function LineUsagePanel({ initial }: { initial?: Usage } = {}) {
  const [u, setU] = useState<Usage | null>(initial ?? null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (initial) return;
    fetch("/api/line/usage").then(async (r) => {
      if (r.ok) setU(await r.json());
      else setErr((await r.json().catch(() => ({}))).error ?? "อ่านข้อมูลไม่สำเร็จ");
    }).catch(() => setErr("อ่านข้อมูลไม่สำเร็จ"));
  }, [initial]);

  const pct = u?.quota.limit ? Math.min(100, ((u.quota.used ?? 0) / Math.max(1, u.quota.limit)) * 100) : 0;
  useTabAlert("quota", "overview", pct >= 80);
  return (
    <section className="card line-usage">
      <CardHead title="โควตาข้อความ LINE เดือนนี้" info="ตัวเลขโควตาจาก LINE รวมการส่งจากระบบอื่นและ LINE OA Manager · reply ฟรีไม่นับโควตา">
        {u?.quota.limit != null && <span className={`chip ${pct >= 80 ? "red" : ""}`}>{Math.round(pct)}%</span>}
      </CardHead>
      {!u ? <div className="muted small">{err || "กำลังโหลด…"}</div> : (
        <>
          {u.quota.error ? <span className="error small">{u.quota.error}</span> : (
            <div className="line-usage-quota">
              <div className="line-usage-line">
                <span><b>{n(u.quota.used ?? 0)}</b>{u.quota.limit != null ? <> / {n(u.quota.limit)} push</> : " push (ไม่จำกัด)"}</span>
                {u.quota.limit != null && <span className="muted small">เหลือ {n(Math.max(0, u.quota.limit - (u.quota.used ?? 0)))}</span>}
              </div>
              {u.quota.limit != null && (
                <div className={`line-usage-bar ${pct >= 90 ? "low" : pct >= 80 ? "warn" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={u.quota.limit} aria-valuenow={u.quota.used ?? 0}>
                  <span style={{ width: `${pct}%` }} />
                </div>
              )}
              <Forecast limit={u.quota.limit} used={u.quota.used ?? 0} />
            </div>
          )}
          <div className="line-usage-stats" aria-label={`DocDesk ส่ง push เดือน ${u.month}`}>
            {LINE_KINDS.map((k) => (
              <div key={k} className="line-usage-stat"><span>{LINE_KIND_LABEL[k]}</span><b>{n(u.push[k])}</b></div>
            ))}
            <div className="line-usage-stat total"><span>รวม push</span><b>{n(u.pushTotal)}</b></div>
          </div>
          <div className="muted tiny-note">
            reply ฟรี {n(u.replyMessages)} ข้อความ ({n(u.replyRequests)} ครั้ง)
            {u.fallbacks > 0 && <> · reply ไม่ทันส่ง push แทน {n(u.fallbacks)}</>}
            {u.failed > 0 && <span className="error"> · ส่งไม่สำเร็จ {n(u.failed)}</span>}
          </div>
        </>
      )}
    </section>
  );
}

const thaiDate = (d: string) => new Date(`${d}T12:00:00+07:00`).toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Bangkok" });

/** ถ้าใช้อัตรานี้ (ตั้งแต่ต้นเดือน) จะหมดประมาณวันที่ไหน */
function Forecast({ limit, used }: { limit: number | null; used: number }) {
  const f = quotaForecast(limit, used);
  if (!f) return null;
  if (limit != null && used >= limit) return <div className="line-usage-forecast error">โควตาเดือนนี้หมดแล้ว</div>;
  return (
    <div className="line-usage-forecast">
      {f.beforeMonthEnd
        ? <>ถ้าใช้อัตรานี้ จะหมดประมาณ <b>{thaiDate(f.date)}</b></>
        : <>ถ้าใช้อัตรานี้ ไม่หมดก่อนสิ้นเดือน</>}
    </div>
  );
}
