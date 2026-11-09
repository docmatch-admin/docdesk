"use client";

import { useEffect, useState } from "react";
import { LINE_KIND_LABEL, LINE_KINDS, quotaForecast, type LineUsageSummary } from "@/lib/line-usage-rules";

type Usage = LineUsageSummary & { quota: { type: string; limit: number | null; used: number | null; error: string | null } };

const n = (v: number) => v.toLocaleString("th-TH");

/** หน้าตั้งค่า: การใช้ข้อความ LINE เดือนนี้ (push นับโควตา reply ฟรี) */
export function LineUsagePanel() {
  const [u, setU] = useState<Usage | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/line/usage").then(async (r) => {
      if (r.ok) setU(await r.json());
      else setErr((await r.json().catch(() => ({}))).error ?? "อ่านข้อมูลไม่สำเร็จ");
    }).catch(() => setErr("อ่านข้อมูลไม่สำเร็จ"));
  }, []);

  return (
    <section className="card line-usage">
      <h3>💬 โควตาข้อความ LINE เดือนนี้</h3>
      {!u ? <div className="muted small">{err || "กำลังโหลด…"}</div> : (
        <>
          <div className="line-usage-quota">
            {u.quota.error ? <span className="error small">{u.quota.error}</span> : (
              <>
                <b>{n(u.quota.used ?? 0)}</b>
                {u.quota.limit != null
                  ? <> / {n(u.quota.limit)} ข้อความ push (เหลือ {n(Math.max(0, u.quota.limit - (u.quota.used ?? 0)))})</>
                  : " ข้อความ push (แพ็กเกจไม่จำกัด)"}
                {u.quota.limit != null && (
                  <div className="line-usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={u.quota.limit} aria-valuenow={u.quota.used ?? 0}>
                    <span style={{ width: `${Math.min(100, ((u.quota.used ?? 0) / Math.max(1, u.quota.limit)) * 100)}%` }} />
                  </div>
                )}
                <Forecast limit={u.quota.limit} used={u.quota.used ?? 0} />
                <div className="muted small">ตัวเลขจาก LINE (รวมการส่งจากระบบอื่นและ LINE OA Manager)</div>
              </>
            )}
          </div>
          <table className="line-usage-table">
            <thead><tr><th>DocDesk ส่ง ({u.month})</th><th>push (นับโควตา)</th></tr></thead>
            <tbody>
              {LINE_KINDS.map((k) => <tr key={k}><td>{LINE_KIND_LABEL[k]}</td><td>{n(u.push[k])}</td></tr>)}
              <tr className="total"><td>รวม push</td><td>{n(u.pushTotal)}</td></tr>
            </tbody>
          </table>
          <div className="small">
            reply (ฟรี ไม่นับโควตา): <b>{n(u.replyMessages)}</b> ข้อความ · {n(u.replyRequests)} ครั้ง
            {u.fallbacks > 0 && <> · reply ไม่ทันแล้วส่ง push แทน {n(u.fallbacks)} ครั้ง</>}
            {u.failed > 0 && <span className="error"> · ส่งไม่สำเร็จ {n(u.failed)} ครั้ง</span>}
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
