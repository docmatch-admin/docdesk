"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { AppointmentDrawer } from "../appointments/appointment-drawer";
import { AppointmentForm, deliveryText, EMPTY_DRAFT, type SaveResult } from "../appointments/appointment-form";
import type { LinkedAccountRow } from "../appointments/linked-accounts";
import { AppointmentsSideView, type SideGroup } from "./appointments-side-view";

/**
 * นัดครั้งต่อไปของแชทนี้ ใช้ฟอร์มเดียวกับหน้านัดหมาย
 * แชท (บัญชี) ผูกได้หลาย HN: แสดงนัดแยกตามคนไข้ ทำนัดให้ HN ไหนเติม HN ชื่อ เบอร์ของคนนั้น ยังไม่ผูกให้กรอกเอง
 */
export function AppointmentsBlock({ conversationId, contactName, blurred, isAdmin, onChanged, onMessage }: {
  conversationId: string;
  isAdmin: boolean;
  contactName: string | null;
  blurred: boolean;
  onChanged: () => void;
  onMessage: (msg: string) => void;
}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [groups, setGroups] = useState<SideGroup[]>([]);
  // ทำนัดให้ HN ไหน (null = กรอกเอง) undefined = ไม่ได้เปิดฟอร์ม
  const [creatingFor, setCreatingFor] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState<{ id: string; edit: boolean } | null>(null);
  // แอดมินยืนยันการจับคู่ HN: ค้นชื่อจาก iService ก่อน แล้วกดยืนยัน
  const [linking, setLinking] = useState(false);
  const [hnInput, setHnInput] = useState("");
  const [preview, setPreview] = useState<{ hn: string; name: string } | null>(null);
  const [linkErr, setLinkErr] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/conversations/${conversationId}/appointments`);
    if (!res.ok) return;
    const j = await res.json();
    setGroups((j.groups ?? []) as SideGroup[]);
  }, [conversationId]);

  useEffect(() => {
    setGroups([]); setCreatingFor(undefined); setOpen(null);
    setLinking(false); setHnInput(""); setPreview(null); setLinkErr("");
    load();
    const ch = sb.channel(`appt-${conversationId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments", filter: `conversation_id=eq.${conversationId}` }, () => load())
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [sb, conversationId, load]);

  function saved(r: SaveResult) {
    setCreatingFor(undefined);
    onMessage(r.delivery ? `บันทึกนัดแล้ว · ${deliveryText(r.delivery)}` : "บันทึกนัดแล้ว");
    load();
    onChanged();
  }

  async function checkHn(e: React.FormEvent) {
    e.preventDefault();
    setLinkErr(""); setPreview(null);
    const res = await fetch(`/api/conversations/${conversationId}/patient-link?hn=${encodeURIComponent(hnInput.trim())}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setLinkErr(j.error ?? "ค้นไม่สำเร็จ");
    setPreview(j as { hn: string; name: string });
  }

  async function confirmLink() {
    if (!preview) return;
    const res = await fetch(`/api/conversations/${conversationId}/patient-link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hn: preview.hn }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setLinkErr(j.error ?? "ผูกไม่สำเร็จ");
    setLinking(false); setPreview(null); setHnInput("");
    onMessage(j.alreadyLinked ? `แชทนี้ผูกกับ HN ${preview.hn} ไว้แล้ว` : `ผูกแชทกับ HN ${preview.hn} แล้ว`);
    load(); onChanged();
  }

  /** ยกเลิกการผูกรายแถว (แชท + HN) */
  async function unlink(target: string, hn: string) {
    const res = await fetch(`/api/conversations/${target}/patient-link?hn=${encodeURIComponent(hn)}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    onMessage(res.ok ? (target === conversationId ? `ยกเลิกการผูก HN ${hn} แล้ว` : "ยกเลิกการผูกบัญชีแล้ว") : j.error ?? "ยกเลิกไม่สำเร็จ");
    load(); onChanged();
  }

  async function patchLink(target: string, body: Record<string, unknown>, ok: string) {
    const r = await fetch(`/api/conversations/${target}/patient-link`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    onMessage(r.ok ? ok : (await r.json().catch(() => ({}))).error ?? "บันทึกไม่สำเร็จ");
    load(); onChanged();
  }

  const target = creatingFor ? groups.find((g) => g.hn === creatingFor) : null;
  const initial = { ...EMPTY_DRAFT, hn: target?.hn ?? "", patient_name: target?.name ?? (creatingFor === null && !groups.some((g) => g.hn) ? contactName ?? "" : ""), phone: target?.phone ?? "" };

  return (
    <>
      <AppointmentsSideView
        isAdmin={isAdmin} groups={groups} blurred={blurred} creating={creatingFor !== undefined}
        onCreate={(hn) => setCreatingFor(creatingFor !== undefined ? undefined : hn)}
        onLinkHn={() => setLinking(!linking)}
        onUnlink={(hn) => unlink(conversationId, hn)}
        onPrimary={(hn) => patchLink(conversationId, { primary_hn: hn }, `ตั้ง HN ${hn} เป็นหลักแล้ว`)}
        onRelation={(a: LinkedAccountRow, relation, hn) => patchLink(a.conversation_id, { relation, hn }, "แก้ป้ายบัญชีแล้ว")}
        onDetach={(a, hn) => unlink(a.conversation_id, hn)}
        onOpen={(id) => setOpen({ id, edit: false })} onEdit={(id) => setOpen({ id, edit: true })}
        printHref={(id) => `/appointments/${id}/print?reprint=1`}>
        {linking && (
          <div className="appt-link-box">
            <form className="row" onSubmit={checkHn}>
              <input style={{ flex: 1, width: "auto", minWidth: 0 }} placeholder="HN" value={hnInput} onChange={(e) => { setHnInput(e.target.value); setPreview(null); }} inputMode="numeric" />
              <button className="btn ghost small" disabled={!hnInput.trim()}>ค้นใน iService</button>
            </form>
            {preview && (
              <div className="row">
                <span className="small">ชื่อใน HIS: <b>{preview.name}</b></span>
                <button type="button" className="btn primary small" onClick={confirmLink}>ยืนยันการจับคู่</button>
              </div>
            )}
            {linkErr && <div className="error small" role="alert">{linkErr}</div>}
          </div>
        )}
        {creatingFor !== undefined && (
          <AppointmentForm key={creatingFor ?? "none"} compact initial={initial} conversationId={conversationId} onCancel={() => setCreatingFor(undefined)} onSaved={saved} />
        )}
      </AppointmentsSideView>
      {open && (
        <AppointmentDrawer id={open.id} canOpenChat={false} isAdmin={isAdmin} initialMode={open.edit ? "edit" : "view"} onClose={() => setOpen(null)}
          onChanged={(m) => { if (m) onMessage(m); load(); onChanged(); }} />
      )}
    </>
  );
}
