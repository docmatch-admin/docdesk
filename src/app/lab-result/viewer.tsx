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

type View = { url: string; expiresIn: number; patientName: string | null; orderDate: string | null; updated: boolean };

const dateTh = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("th-TH", { dateStyle: "long", timeZone: "Asia/Bangkok" }) : null);

/** เปิดผ่าน LIFF → ส่ง ID token ให้ server ตรวจว่าบัญชี LINE นี้ผูกกับเจ้าของผล → ได้ signed URL อายุ 10 นาที */
export function LabResultViewer({ liffId }: { liffId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [liff, setLiff] = useState<Liff | null>(null);

  const open = useCallback(async (l: Liff) => {
    setLoading(true);
    setError(null);
    const id = new URLSearchParams(window.location.search).get("id");
    const idToken = l.getIDToken();
    if (!id) { setError("ลิงก์ไม่ถูกต้อง กรุณากดปุ่ม \"ดูผล\" จากข้อความใน LINE อีกครั้ง"); setLoading(false); return; }
    if (!idToken) { setError("ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจาก LINE อีกครั้ง"); setLoading(false); return; }
    const res = await fetch("/api/lab-results/view", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, idToken }) }).catch(() => null);
    const j = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) setError(j.error ?? "เปิดผลไม่สำเร็จ ลองใหม่อีกครั้ง");
    else setView(j as View);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!liffId) { setError("ยังไม่ได้ตั้งค่าการเปิดผลผ่าน LINE กรุณาติดต่อคลินิก"); setLoading(false); return; }
    loadSdk()
      .then(async (l) => {
        await l.init({ liffId });
        if (!l.isLoggedIn()) { l.login({ redirectUri: window.location.href }); return; }
        setLiff(l);
        await open(l);
      })
      .catch(() => { setError("เปิดผ่าน LINE ไม่สำเร็จ กรุณาเปิดจากแอป LINE อีกครั้ง"); setLoading(false); });
  }, [liffId, open]);

  const openFile = () => {
    if (!view) return;
    // ในแอป LINE บางเครื่องแสดง PDF ในหน้าไม่ได้: เปิดด้วยเบราว์เซอร์ของเครื่อง
    if (liff?.isInClient()) liff.openWindow({ url: view.url, external: true });
    else window.open(view.url, "_blank", "noopener");
  };

  return (
    <main className="lab-viewer">
      <h1 style={{ margin: 0, fontSize: 20 }}>ผลแล็บ</h1>
      {loading && <p className="muted">กำลังเปิดผล…</p>}
      {error && <p className="error">{error}</p>}
      {view && (
        <>
          <div>
            {view.patientName && <b>{view.patientName}</b>}
            {view.orderDate && <div className="muted small">วันที่ตรวจ {dateTh(view.orderDate)}</div>}
            {view.updated && <div className="small" style={{ color: "var(--warning-ink)" }}>ฉบับปรับปรุงล่าสุด (แล็บแก้ไขผล)</div>}
          </div>
          <div className="row">
            <button type="button" className="btn primary" onClick={openFile}>เปิดไฟล์ PDF</button>
            {liff && <button type="button" className="btn ghost" onClick={() => open(liff)}>โหลดใหม่</button>}
          </div>
          <p className="muted small">ลิงก์ไฟล์ใช้ได้ 10 นาที ถ้าเปิดไม่ได้ให้กด &quot;โหลดใหม่&quot; · มีข้อสงสัยเกี่ยวกับผล ทักแชทถามคลินิกได้เลย</p>
          <iframe src={view.url} title="ผลแล็บ PDF" />
        </>
      )}
    </main>
  );
}
