"use client";

import { useCallback, useEffect, useState } from "react";

const LIFF_SDK = "https://static.line-scdn.net/liff/edge/2/sdk.js";

interface Liff {
  init(opts: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  login(opts?: { redirectUri?: string }): void;
  getIDToken(): string | null;
  isInClient(): boolean;
  openWindow(opts: { url: string; external: boolean }): void;
}
declare global { interface Window { liff?: Liff } }

function loadSdk(): Promise<Liff> {
  if (window.liff) return Promise.resolve(window.liff);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LIFF_SDK;
    s.async = true;
    s.onload = () => (window.liff ? resolve(window.liff) : reject(new Error("LIFF SDK โหลดไม่สำเร็จ")));
    s.onerror = () => reject(new Error("LIFF SDK โหลดไม่สำเร็จ"));
    document.head.appendChild(s);
  });
}

interface Appt { id: string; when: string; status: string; canConfirm: boolean }
interface View { url: string; downloadUrl: string; expiresIn: number; patientName: string | null; orderDate: string | null; ln: string | null; updated: boolean; version: number; appointment: Appt | null }
interface Item { id: string; ln: string | null; orderDate: string | null; patientName: string | null; updated: boolean; version: number; viewed: boolean; appointment: Appt | null }

const dateTh = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("th-TH", { dateStyle: "long", timeZone: "Asia/Bangkok" }) : "–");

async function post<T>(path: string, body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const j = res ? await res.json().catch(() => ({})) : {};
  return res?.ok ? { ok: true, data: j as T } : { ok: false, error: (j as { error?: string }).error ?? "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง" };
}

/**
 * หน้าคนไข้ (LIFF): ?id= เปิดผลรายการเดียว · ไม่มี id = "ผลแล็บของฉัน" (ทุกผลของ HN ที่ผูกกับบัญชี LINE นี้)
 * ทุกครั้งส่ง ID token ให้ server ตรวจว่าบัญชีนี้เป็นเจ้าของ → ได้ signed URL อายุ 10 นาทีต่อการเปิดหนึ่งครั้ง
 */
export function LabResultViewer({ liffId }: { liffId: string }) {
  const [liff, setLiff] = useState<Liff | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [linked, setLinked] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());

  const token = useCallback((l: Liff) => l.getIDToken(), []);

  const openOne = useCallback(async (l: Liff, labId: string) => {
    setLoading(true); setError(null); setView(null);
    const t = token(l);
    if (!t) { setError("ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจาก LINE อีกครั้ง"); setLoading(false); return; }
    const r = await post<View>("/api/lab-results/view", { id: labId, idToken: t });
    if (r.ok) setView(r.data); else setError(r.error);
    setLoading(false);
  }, [token]);

  const openList = useCallback(async (l: Liff) => {
    setLoading(true); setError(null); setView(null);
    const t = token(l);
    if (!t) { setError("ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจาก LINE อีกครั้ง"); setLoading(false); return; }
    const r = await post<{ linked: boolean; results: Item[] }>("/api/lab-results/mine", { idToken: t });
    if (r.ok) { setItems(r.data.results); setLinked(r.data.linked); } else setError(r.error);
    setLoading(false);
  }, [token]);

  useEffect(() => {
    if (!liffId) { setError("ยังไม่ได้ตั้งค่าการเปิดผลผ่าน LINE กรุณาติดต่อคลินิก"); setLoading(false); return; }
    loadSdk()
      .then(async (l) => {
        await l.init({ liffId });
        if (!l.isLoggedIn()) { l.login({ redirectUri: window.location.href }); return; }
        setLiff(l);
        const labId = new URLSearchParams(window.location.search).get("id");
        setId(labId);
        if (labId) await openOne(l, labId); else await openList(l);
      })
      .catch(() => { setError("เปิดผ่าน LINE ไม่สำเร็จ กรุณาเปิดจากแอป LINE อีกครั้ง"); setLoading(false); });
  }, [liffId, openOne, openList]);

  const openUrl = (url: string) => {
    // ในแอป LINE บางเครื่องแสดง/ดาวน์โหลด PDF ในหน้าไม่ได้: เปิดด้วยเบราว์เซอร์ของเครื่อง
    if (liff?.isInClient()) liff.openWindow({ url, external: true });
    else window.open(url, "_blank", "noopener");
  };

  async function confirm(appt: Appt) {
    if (!liff) return;
    const t = token(liff);
    if (!t) return setError("ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจาก LINE อีกครั้ง");
    const r = await post<{ status: string }>("/api/lab-results/confirm", { appointmentId: appt.id, idToken: t });
    if (r.ok) setConfirmed((s) => new Set(s).add(appt.id)); else setError(r.error);
  }

  const apptBox = (a: Appt | null) => a && (
    <div className="card" style={{ padding: 12 }}>
      <div className="muted small">นัดฟังผล</div>
      <b>{a.when}</b>
      {a.status === "confirmed" || confirmed.has(a.id)
        ? <div className="small" style={{ color: "var(--success-ink)" }}>ยืนยันนัดแล้ว</div>
        : a.canConfirm && <div style={{ marginTop: 6 }}><button type="button" className="btn primary small" onClick={() => confirm(a)}>ยืนยันนัด</button></div>}
    </div>
  );

  const backToList = () => {
    if (!liff) return;
    setId(null);
    window.history.replaceState(null, "", `${window.location.pathname}?mine=1`);
    openList(liff);
  };

  return (
    <main className="lab-viewer">
      <h1 style={{ margin: 0, fontSize: 20 }}>{id ? "ผลแล็บ" : "ผลแล็บของฉัน"}</h1>
      {loading && <p className="muted">กำลังเปิด…</p>}
      {error && <p className="error">{error}</p>}

      {id && view && (
        <>
          <div>
            {view.patientName && <b>{view.patientName}</b>}
            <div className="muted small">วันที่ตรวจ {dateTh(view.orderDate)}{view.ln ? ` · LN ${view.ln}` : ""}</div>
            {view.updated && <div className="small" style={{ color: "var(--warning-ink)" }}>ฉบับแก้ไข v{view.version} (แล็บแก้ผล)</div>}
          </div>
          {apptBox(view.appointment)}
          <div className="row">
            <button type="button" className="btn primary" onClick={() => openUrl(view.url)}>เปิดไฟล์</button>
            <button type="button" className="btn ghost" onClick={() => openUrl(view.downloadUrl)}>ดาวน์โหลด PDF</button>
            {liff && <button type="button" className="btn ghost" onClick={() => openOne(liff, id)}>โหลดใหม่</button>}
          </div>
          <p className="muted small">ลิงก์ไฟล์ใช้ได้ 10 นาที ถ้าเปิดไม่ได้ให้กด &quot;โหลดใหม่&quot; · มีข้อสงสัยเกี่ยวกับผล ทักแชทถามคลินิกได้เลย</p>
          <iframe src={view.url} title="ผลแล็บ PDF" />
          <button type="button" className="link-btn" onClick={backToList}>ดูผลแล็บทั้งหมดของฉัน</button>
        </>
      )}

      {!id && items && (
        <>
          {!linked && <p className="muted">บัญชี LINE นี้ยังไม่ได้ผูกกับคลินิก — สแกน QR บนใบนัดหรือทักแชทให้เจ้าหน้าที่ผูกให้</p>}
          {linked && !items.length && <p className="muted">ยังไม่มีผลแล็บ</p>}
          {items.map((it) => (
            <div key={it.id} className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4 }}>
              {it.patientName && <b>{it.patientName}</b>}
              <div><b>วันที่ตรวจ {dateTh(it.orderDate)}</b>{it.updated && <span className="lab-chip wait" style={{ marginLeft: 6 }}>แก้ผล v{it.version}</span>}</div>
              {it.ln && <div className="muted small">LN {it.ln}</div>}
              {it.appointment && <div className="small">นัดฟังผล: {it.appointment.when}</div>}
              <div><button type="button" className="btn primary small" onClick={() => { if (!liff) return; setId(it.id); window.history.replaceState(null, "", `${window.location.pathname}?id=${encodeURIComponent(it.id)}`); openOne(liff, it.id); }}>ดูผล</button></div>
            </div>
          ))}
        </>
      )}
    </main>
  );
}
