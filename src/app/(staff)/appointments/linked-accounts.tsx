"use client";

import { useState } from "react";

export interface LinkedAccountRow {
  conversation_id: string;
  channel: string | null;
  name: string | null;
  relation: "patient" | "relative";
  following: boolean;
  primary: boolean;
  via: "hn" | "code";
}

const CHANNEL: Record<string, string> = { line: "LINE", facebook: "Facebook", instagram: "Instagram", web: "เว็บ" };

/**
 * บัญชีที่รับข้อความนัดของคนไข้คนนี้ (คนไข้ + ญาติผู้ดูแล)
 * แอดมินแก้ป้าย คนไข้/ญาติ และยกเลิกการผูกรายบัญชีได้
 */
export function LinkedAccounts({ accounts, isAdmin, setRelation, detach }: {
  accounts: LinkedAccountRow[];
  isAdmin: boolean;
  setRelation: (a: LinkedAccountRow, relation: "patient" | "relative") => Promise<void>;
  detach: (a: LinkedAccountRow) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!accounts.length) return null;

  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id);
    try { await fn(); } finally { setBusy(null); setConfirm(null); }
  }

  return (
    <div className="linked-accounts">
      <div className="linked-accounts-head">บัญชีที่รับแจ้งเตือน ({accounts.length})</div>
      <ul>
        {accounts.map((a) => (
          <li key={a.conversation_id} className={a.following ? "" : "off"}>
            <span className="linked-accounts-name">
              <b>{a.name || "ไม่มีชื่อบัญชี"}</b>
              <span className="muted small"> · {CHANNEL[a.channel ?? ""] ?? a.channel ?? "–"}{a.following ? "" : " · เลิกติดตาม"}</span>
            </span>
            {isAdmin ? (
              <select aria-label={`ป้ายของ ${a.name ?? "บัญชี"}`} value={a.relation} disabled={busy === a.conversation_id}
                onChange={(e) => run(a.conversation_id, () => setRelation(a, e.target.value as "patient" | "relative"))}>
                <option value="patient">คนไข้</option>
                <option value="relative">ญาติ</option>
              </select>
            ) : (
              <span className="chip tiny">{a.relation === "relative" ? "ญาติ" : "คนไข้"}</span>
            )}
            {isAdmin && (
              <button type="button" className={`btn ghost small ${confirm === a.conversation_id ? "danger" : ""}`} disabled={busy === a.conversation_id}
                onClick={() => (confirm === a.conversation_id ? run(a.conversation_id, () => detach(a)) : setConfirm(a.conversation_id))}>
                {confirm === a.conversation_id ? "ยืนยันยกเลิกผูก?" : "ยกเลิกผูก"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
