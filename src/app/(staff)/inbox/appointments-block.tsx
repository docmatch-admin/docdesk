"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { useLiveChannel } from "@/lib/use-live-channel";
import { chatBundle } from "@/lib/chat-bundle";
import { AppointmentDrawer } from "../appointments/appointment-drawer";
import { AppointmentForm, deliveryText, EMPTY_DRAFT, type SaveResult } from "../appointments/appointment-form";
import type { LinkedAccountRow } from "../appointments/linked-accounts";
import { AppointmentsSideView, type SideGroup } from "./appointments-side-view";
import { summarize, type ApptSummary } from "./mobile-chat";

/**
 * นัดครั้งต่อไปของแชทนี้ ใช้ฟอร์มเดียวกับหน้านัดหมาย
 * แชท (บัญชี) ผูกได้หลาย HN: แสดงนัดแยกตามคนไข้ ทำนัดให้ HN ไหนเติม HN ชื่อ เบอร์ของคนนั้น ยังไม่ผูกให้กรอกเอง
 */
export function AppointmentsBlock({ conversationId, contactName, blurred, isAdmin, onChanged, onMessage, onSummary, footer }: {
  conversationId: string;
  isAdmin: boolean;
  contactName: string | null;
  blurred: boolean;
  onChanged: () => void;
  onMessage: (msg: string) => void;
  /** นัดที่ยังไม่ถึงทั้งหมด + นัดที่ใกล้สุด (แถบ "นัดถัดไป" และป้ายบนแท็บนัดในมือถือ) */
  onSummary?: (s: ApptSummary) => void;
  /** ท้ายการ์ดนัด (ผลแล็บล่าสุด) */
  footer?: React.ReactNode;
}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [groups, setGroups] = useState<SideGroup[]>([]);
  // ทำนัดให้ HN ไหน (null = กรอกเอง) undefined = ไม่ได้เปิดฟอร์ม
  const [creatingFor, setCreatingFor] = useState<string | null | undefined>(undefined);
  // ปุ่มจากกล่องข้อมูลลูกค้า: "ทำนัด" (มือถือ) และ "แก้ไขการเชื่อมคนไข้" (คอม)
  useEffect(() => {
    const onNew = () => setCreatingFor((cur) => (cur !== undefined ? cur : null));
    const onLink = () => setLinking(true);
    window.addEventListener("docdesk:new-appt", onNew);
    window.addEventListener("docdesk:link-hn", onLink);
    return () => { window.removeEventListener("docdesk:new-appt", onNew); window.removeEventListener("docdesk:link-hn", onLink); };
  }, []);
  const [open, setOpen] = useState<{ id: string; mode: "view" | "edit" | "cancel" } | null>(null);
  // แอดมินยืนยันการจับคู่ HN: ค้นชื่อจาก iService ก่อน แล้วกดยืนยัน
  const [linking, setLinking] = useState(false);
  const [hnInput, setHnInput] = useState("");
  const [preview, setPreview] = useState<{ hn: string; name: string } | null>(null);
  const [linkErr, setLinkErr] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/conversations/${conversationId}/appointments`);
    if (!res.ok) return;
    const j = await res.json();
    const g = (j.groups ?? []) as SideGroup[];
    setGroups(g);
    onSummary?.(summarize(g));
  }, [conversationId, onSummary]);

  useEffect(() => {
    setGroups([]); setCreatingFor(undefined); setOpen(null);
    setLinking(false); setHnInput(""); setPreview(null); setLinkErr("");
    // ตอนเปิดแชทใช้ข้อมูลชุดเดียวกับห้องแชท (ไม่ยิงแยก)
    let alive = true;
    chatBundle(conversationId).then((b) => {
      if (!alive) return;
      if (!b?.appointments) return void load();
      const g = (b.appointments.groups ?? []) as SideGroup[];
      setGroups(g);
      onSummary?.(summarize(g));
    });
    return () => { alive = false; };
  }, [conversationId, load]);
  useLiveChannel(sb, `appt-${conversationId}`,
    (ch) => ch.on("postgres_changes", { event: "*", schema: "public", table: "appointments", filter: `conversation_id=eq.${conversationId}` }, () => load()),
    () => load());

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
        onOpen={(id) => setOpen({ id, mode: "view" })} onEdit={(id) => setOpen({ id, mode: "edit" })}
        onCancel={(id) => setOpen({ id, mode: "cancel" })} footer={footer}>
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
        <AppointmentDrawer id={open.id} canOpenChat={false} isAdmin={isAdmin} initialMode={open.mode} onClose={() => setOpen(null)}
          onChanged={(m) => { if (m) onMessage(m); load(); onChanged(); }} />
      )}
    </>
  );
}
