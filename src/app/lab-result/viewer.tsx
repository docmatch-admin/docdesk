"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

type Lang = "th" | "en";
interface Appt { id: string; when: string; status: string; canConfirm: boolean }
interface Req { date: string; time: string; when: string }
interface View { url: string; downloadUrl: string; expiresIn: number; patientName: string | null; orderDate: string | null; ln: string | null; updated: boolean; version: number; appointment: Appt | null; request: Req | null; lang?: Lang | null }
interface Item { id: string; ln: string | null; orderDate: string | null; patientName: string | null; updated: boolean; version: number; viewed: boolean; appointment: Appt | null; request: Req | null }
interface BookInfo { patientName: string | null; orderDate: string | null; appointment: Appt | null; request: Req | null; days: { date: string; label: string; times: string[] }[]; lang?: Lang | null }

/** ข้อความหน้าคนไข้: ไทย / อังกฤษ (บัญชี LINE ที่ภาษาไม่ใช่ไทย หรือเบราว์เซอร์ไม่ใช่ไทยเมื่อยังไม่รู้ภาษาบัญชี) */
export const VIEWER_TEXT = {
  th: {
    titleBook: "เลือกวันนัดฟังผล", titleOne: "ผลแล็บ", titleMine: "ผลแล็บของฉัน", opening: "กำลังเปิด…",
    authFail: "ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจาก LINE อีกครั้ง", noLiff: "ยังไม่ได้ตั้งค่าการเปิดผลผ่าน LINE กรุณาติดต่อคลินิก",
    liffFail: "เปิดผ่าน LINE ไม่สำเร็จ กรุณาเปิดจากแอป LINE อีกครั้ง", genericFail: "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง",
    appt: "นัดฟังผล", confirmed: "ยืนยันนัดแล้ว", confirm: "ยืนยันนัด", requested: "ส่งคำขอนัดแล้ว รอคลินิกยืนยัน", changeRequest: "เปลี่ยนวันที่ขอ",
    noAppt: "ยังไม่มีนัดฟังผล", choose: "เลือกวันนัดฟังผล", orderDate: "วันที่ตรวจ", resultDate: "ผลตรวจวันที่",
    revised: (v: number) => `ฉบับแก้ไข v${v} (แล็บแก้ผล)`, revisedChip: (v: number) => `แก้ผล v${v}`,
    openFile: "เปิดไฟล์", download: "ดาวน์โหลด PDF", reload: "โหลดใหม่",
    linkNote: "ลิงก์ไฟล์ใช้ได้ 10 นาที ถ้าเปิดไม่ได้ให้กด \"โหลดใหม่\" · มีข้อสงสัยเกี่ยวกับผล ทักแชทถามคลินิกได้เลย", pdfNote: null as string | null,
    pdfTitle: "ผลแล็บ PDF", mine: "ดูผลแล็บทั้งหมดของฉัน", sentTitle: "ส่งคำขอนัดแล้ว", waitChip: "รอคลินิกยืนยัน",
    sentNote: "เจ้าหน้าที่จะยืนยันนัดและส่งข้อความนัดให้ทาง LINE", changeDay: "เปลี่ยนวัน", backToResult: "กลับไปดูผล",
    oldRequest: (when: string) => `มีคำขอเดิม ${when} (รอคลินิกยืนยัน) — เลือกใหม่เพื่อเปลี่ยนวันที่ขอ`,
    step1: "1. เลือกวัน", noDays: "ช่วงนี้ไม่มีเวลาว่างให้เลือก กรุณาทักแชทนัดกับเจ้าหน้าที่", pickDayAria: "เลือกวัน", step2: "2. เลือกเวลา",
    pickDayFirst: "เลือกวันก่อน", pickTimeAria: "เลือกเวลา", sending: "กำลังส่ง…", send: "ส่งคำขอนัด",
    sendHint: "เลือกวันและเวลาก่อน แล้วกด \"ส่งคำขอนัด\"", sendAfter: "คลินิกจะยืนยันนัดให้อีกครั้ง",
    notLinked: "บัญชี LINE นี้ยังไม่ได้ผูกกับคลินิก — สแกน QR บนใบนัดหรือทักแชทให้เจ้าหน้าที่ผูกให้", noResults: "ยังไม่มีผลแล็บ",
    listAppt: (text: string) => `นัดฟังผล: ${text}`, waitSuffix: " (รอคลินิกยืนยัน)", noApptShort: "ยังไม่มีนัด", view: "ดูผล", locale: "th-TH",
  },
  en: {
    titleBook: "Choose a results appointment", titleOne: "Lab results", titleMine: "My lab results", opening: "Opening…",
    authFail: "Could not verify your LINE account. Please open this page from LINE again.", noLiff: "Viewing results through LINE is not set up yet. Please contact the clinic.",
    liffFail: "Could not open through LINE. Please open it from the LINE app again.", genericFail: "Something went wrong. Please try again.",
    appt: "Results appointment", confirmed: "Appointment confirmed", confirm: "Confirm", requested: "Request sent — waiting for the clinic to confirm", changeRequest: "Change requested date",
    noAppt: "No results appointment yet", choose: "Choose a date", orderDate: "Test date", resultDate: "Test date",
    revised: (v: number) => `Revised version v${v} (corrected by the laboratory)`, revisedChip: (v: number) => `Revised v${v}`,
    openFile: "Open file", download: "Download PDF", reload: "Reload",
    linkNote: "The file link works for 10 minutes. If it doesn't open, tap \"Reload\". Questions about your results? Message the clinic.",
    pdfNote: "This report is issued by the laboratory in its original language." as string | null,
    pdfTitle: "Lab results PDF", mine: "All my lab results", sentTitle: "Request sent", waitChip: "Waiting for the clinic to confirm",
    sentNote: "Our staff will confirm and send your appointment by LINE.", changeDay: "Change date", backToResult: "Back to results",
    oldRequest: (when: string) => `You already requested ${when} (waiting for confirmation). Choose again to change it.`,
    step1: "1. Choose a day", noDays: "No times are available right now. Please message the clinic to book.", pickDayAria: "Choose a day", step2: "2. Choose a time",
    pickDayFirst: "Choose a day first", pickTimeAria: "Choose a time", sending: "Sending…", send: "Send request",
    sendHint: "Choose a day and time, then tap \"Send request\"", sendAfter: "The clinic will confirm your appointment.",
    notLinked: "This LINE account is not linked to the clinic yet. Scan the QR code on your appointment card or message our staff.", noResults: "No lab results yet",
    listAppt: (text: string) => `Results appointment: ${text}`, waitSuffix: " (waiting for confirmation)", noApptShort: "No appointment yet", view: "View results", locale: "en-GB",
  },
};

/** ภาษาเริ่มต้นก่อนรู้ภาษาของบัญชี: ตามเบราว์เซอร์ */
export const browserLang = (nav: string | undefined): Lang => (!nav || nav.toLowerCase().startsWith("th") ? "th" : "en");

/** error จาก server เป็นภาษาไทย: หน้าอังกฤษแปลตามรหัสสถานะ */
export function errorFor(lang: Lang, status: number | null, serverError: string | undefined): string {
  if (lang === "th") return serverError ?? VIEWER_TEXT.th.genericFail;
  if (status === 404) return "This lab result or appointment was not found in your LINE account.";
  if (status === 409) return "This can't be done right now (an appointment may already exist or it has closed).";
  if (status === 400) return "That date or time can't be chosen. Please choose again.";
  if (status === 401) return VIEWER_TEXT.en.authFail;
  return VIEWER_TEXT.en.genericFail;
}

const dateIn = (iso: string | null, locale: string) => (iso ? new Date(iso).toLocaleDateString(locale, { dateStyle: "long", timeZone: "Asia/Bangkok" }) : "–");

async function post<T>(path: string, body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error?: string; status: number | null }> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const j = res ? await res.json().catch(() => ({})) : {};
  return res?.ok ? { ok: true, data: j as T } : { ok: false, error: (j as { error?: string }).error, status: res?.status ?? null };
}

/**
 * หน้าคนไข้ (LIFF): ?id= เปิดผลรายการเดียว · ?book= เลือกวันนัดฟังผล · ไม่มี = "ผลแล็บของฉัน" (ทุกผลของ HN ที่ผูกกับบัญชี LINE นี้)
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
  const [bookId, setBookId] = useState<string | null>(null);
  const [book, setBook] = useState<BookInfo | null>(null);
  const [pickDate, setPickDate] = useState<string | null>(null);
  const [pickTime, setPickTime] = useState<string | null>(null);
  const [sent, setSent] = useState<Req | null>(null);
  const [sending, setSending] = useState(false);
  // ภาษา: บัญชี LINE (จาก server) ก่อน ไม่รู้ = ภาษาเบราว์เซอร์
  const [lang, setLang] = useState<Lang>("th");
  const langRef = useRef<Lang>("th");
  const applyLang = useCallback((l: Lang | null | undefined) => { if (l) { langRef.current = l; setLang(l); } }, []);
  useEffect(() => { applyLang(browserLang(navigator.language)); }, [applyLang]);
  const T = VIEWER_TEXT[lang];
  const fail = useCallback((r: { error?: string; status: number | null }) => setError(errorFor(langRef.current, r.status, r.error)), []);

  const token = useCallback((l: Liff) => l.getIDToken(), []);

  const openOne = useCallback(async (l: Liff, labId: string) => {
    setLoading(true); setError(null); setView(null);
    const t = token(l);
    if (!t) { setError(VIEWER_TEXT[langRef.current].authFail); setLoading(false); return; }
    const r = await post<View>("/api/lab-results/view", { id: labId, idToken: t });
    if (r.ok) { applyLang(r.data.lang); setView(r.data); } else fail(r);
    setLoading(false);
  }, [token, applyLang, fail]);

  const openList = useCallback(async (l: Liff) => {
    setLoading(true); setError(null); setView(null);
    const t = token(l);
    if (!t) { setError(VIEWER_TEXT[langRef.current].authFail); setLoading(false); return; }
    const r = await post<{ linked: boolean; results: Item[]; lang?: Lang | null }>("/api/lab-results/mine", { idToken: t });
    if (r.ok) { applyLang(r.data.lang); setItems(r.data.results); setLinked(r.data.linked); } else fail(r);
    setLoading(false);
  }, [token, applyLang, fail]);

  const openBook = useCallback(async (l: Liff, labId: string) => {
    setLoading(true); setError(null); setView(null); setSent(null); setPickDate(null); setPickTime(null);
    const t = token(l);
    if (!t) { setError(VIEWER_TEXT[langRef.current].authFail); setLoading(false); return; }
    const r = await post<BookInfo>("/api/lab-results/booking", { id: labId, idToken: t });
    if (r.ok) { applyLang(r.data.lang); setBook(r.data); setPickDate(r.data.request?.date ?? r.data.days[0]?.date ?? null); setPickTime(r.data.request?.time ?? null); } else fail(r);
    setLoading(false);
  }, [token, applyLang, fail]);

  useEffect(() => {
    if (!liffId) { setError(VIEWER_TEXT[browserLang(navigator.language)].noLiff); setLoading(false); return; }
    loadSdk()
      .then(async (l) => {
        await l.init({ liffId });
        if (!l.isLoggedIn()) { l.login({ redirectUri: window.location.href }); return; }
        setLiff(l);
        const q = new URLSearchParams(window.location.search);
        const labId = q.get("id");
        const bookFor = q.get("book");
        setId(labId);
        setBookId(bookFor);
        if (bookFor) await openBook(l, bookFor);
        else if (labId) await openOne(l, labId);
        else await openList(l);
      })
      .catch(() => { setError(VIEWER_TEXT[langRef.current].liffFail); setLoading(false); });
  }, [liffId, openOne, openList, openBook]);

  const openUrl = (url: string) => {
    // ในแอป LINE บางเครื่องแสดง/ดาวน์โหลด PDF ในหน้าไม่ได้: เปิดด้วยเบราว์เซอร์ของเครื่อง
    if (liff?.isInClient()) liff.openWindow({ url, external: true });
    else window.open(url, "_blank", "noopener");
  };

  async function confirm(appt: Appt) {
    if (!liff) return;
    const t = token(liff);
    if (!t) return setError(T.authFail);
    const r = await post<{ status: string }>("/api/lab-results/confirm", { appointmentId: appt.id, idToken: t });
    if (r.ok) setConfirmed((s) => new Set(s).add(appt.id)); else fail(r);
  }

  const goBook = (labId: string) => {
    if (!liff) return;
    setId(null);
    setBookId(labId);
    window.history.replaceState(null, "", `${window.location.pathname}?book=${encodeURIComponent(labId)}`);
    openBook(liff, labId);
  };

  async function sendRequest() {
    if (!liff || !bookId || !pickDate || !pickTime) return;
    const t = token(liff);
    if (!t) return setError(T.authFail);
    setSending(true); setError(null);
    const r = await post<Req>("/api/lab-results/request-appointment", { id: bookId, idToken: t, date: pickDate, time: pickTime });
    setSending(false);
    if (r.ok) setSent(r.data); else fail(r);
  }

  /** ส่วนนัดฟังผล (กติกาเดียวกับการ์ด LINE): มีนัด = วันเวลา + ยืนยัน · มีคำขอ = รอคลินิกยืนยัน · ไม่มี = ปุ่มเลือกวัน */
  const apptBox = (a: Appt | null, q: Req | null, labId: string) => (
    <div className="card" style={{ padding: 12 }}>
      <div className="muted small">{T.appt}</div>
      {a ? (
        <>
          <b>{a.when}</b>
          {a.status === "confirmed" || confirmed.has(a.id)
            ? <div className="small" style={{ color: "var(--success-ink)" }}>{T.confirmed}</div>
            : <div style={{ marginTop: 6 }}><button type="button" className="btn primary small" disabled={!a.canConfirm} onClick={() => confirm(a)}>{T.confirm}</button></div>}
        </>
      ) : q ? (
        <>
          <b>{q.when}</b>
          <div className="small" style={{ color: "var(--warning-ink)" }}>{T.requested}</div>
          <div style={{ marginTop: 6 }}><button type="button" className="btn ghost small" onClick={() => goBook(labId)}>{T.changeRequest}</button></div>
        </>
      ) : (
        <>
          <div className="muted">{T.noAppt}</div>
          <div style={{ marginTop: 6 }}><button type="button" className="btn primary small" onClick={() => goBook(labId)}>{T.choose}</button></div>
        </>
      )}
    </div>
  );

  const backToList = () => {
    if (!liff) return;
    setId(null);
    setBookId(null);
    window.history.replaceState(null, "", `${window.location.pathname}?mine=1`);
    openList(liff);
  };

  return (
    <main className="lab-viewer" lang={lang}>
      <h1 style={{ margin: 0, fontSize: 20 }}>{bookId ? T.titleBook : id ? T.titleOne : T.titleMine}</h1>
      {loading && <p className="muted">{T.opening}</p>}
      {error && <p className="error">{error}</p>}

      {id && !bookId && view && (
        <>
          <div>
            {view.patientName && <b>{view.patientName}</b>}
            <div className="muted small">{T.orderDate} {dateIn(view.orderDate, T.locale)}</div>
            {view.updated && <div className="small" style={{ color: "var(--warning-ink)" }}>{T.revised(view.version)}</div>}
          </div>
          {apptBox(view.appointment, view.request, id)}
          <div className="row">
            <button type="button" className="btn primary" onClick={() => openUrl(view.url)}>{T.openFile}</button>
            <button type="button" className="btn ghost" onClick={() => openUrl(view.downloadUrl)}>{T.download}</button>
            {liff && <button type="button" className="btn ghost" onClick={() => openOne(liff, id)}>{T.reload}</button>}
          </div>
          <p className="muted small">{T.linkNote}</p>
          {/* ไม่แปลไฟล์ PDF: แจ้งว่าใบผลเป็นภาษาต้นฉบับของแล็บ */}
          {T.pdfNote && <p className="small">{T.pdfNote}</p>}
          <iframe src={view.url} title={T.pdfTitle} />
          <button type="button" className="link-btn" onClick={backToList}>{T.mine}</button>
        </>
      )}

      {bookId && book && (
        <>
          {book.patientName && <div><b>{book.patientName}</b>{book.orderDate && <div className="muted small">{T.resultDate} {dateIn(book.orderDate, T.locale)}</div>}</div>}
          {sent ? (
            /* หน้า "ส่งคำขอนัดแล้ว" */
            <div className="card lab-book-sent">
              <b>{T.sentTitle}</b>
              <div className="lab-book-when">{sent.when}</div>
              <span className="lab-chip wait">{T.waitChip}</span>
              <div className="muted small">{T.sentNote}</div>
              <div className="lab-book-actions">
                <button type="button" className="btn ghost" onClick={() => { setSent(null); setPickDate(sent.date); setPickTime(sent.time); }}>{T.changeDay}</button>
                <button type="button" className="btn primary" onClick={() => { if (!liff) return; const labId = bookId; setBookId(null); setId(labId); window.history.replaceState(null, "", `${window.location.pathname}?id=${encodeURIComponent(labId)}`); openOne(liff, labId); }}>{T.backToResult}</button>
              </div>
            </div>
          ) : book.appointment ? (
            apptBox(book.appointment, null, bookId)
          ) : (
            <div className="lab-book">
              {book.request && <p className="small" style={{ color: "var(--warning-ink)" }}>{T.oldRequest(book.request.when)}</p>}
              <h2 className="lab-book-step">{T.step1}</h2>
              {!book.days.length && <p className="muted">{T.noDays}</p>}
              <div className="lab-book-days" role="radiogroup" aria-label={T.pickDayAria}>
                {book.days.map((d) => (
                  <button key={d.date} type="button" role="radio" aria-checked={pickDate === d.date} className={`lab-book-day ${pickDate === d.date ? "on" : ""}`}
                    onClick={() => { setPickDate(d.date); setPickTime(null); }}>{d.label}</button>
                ))}
              </div>
              <h2 className="lab-book-step">{T.step2}</h2>
              {!pickDate
                ? <p className="muted small">{T.pickDayFirst}</p>
                : (
                  <div className="lab-book-times" role="radiogroup" aria-label={T.pickTimeAria}>
                    {(book.days.find((d) => d.date === pickDate)?.times ?? []).map((t) => (
                      <button key={t} type="button" role="radio" aria-checked={pickTime === t} className={`lab-book-time ${pickTime === t ? "on" : ""}`}
                        onClick={() => setPickTime(t)}>{t}</button>
                    ))}
                  </div>
                )}
              {/* ปุ่มส่งอยู่ล่างสุดเสมอ: กดได้เมื่อเลือกเวลาแล้ว */}
              <div className="lab-book-submit">
                <button type="button" className="btn primary" disabled={!pickDate || !pickTime || sending} onClick={sendRequest}>
                  {sending ? T.sending : T.send}
                </button>
                <p className="muted small">{!pickTime ? T.sendHint : T.sendAfter}</p>
              </div>
            </div>
          )}
          {!sent && <button type="button" className="link-btn" onClick={backToList}>{T.mine}</button>}
        </>
      )}

      {!id && !bookId && items && (
        <>
          {!linked && <p className="muted">{T.notLinked}</p>}
          {linked && !items.length && <p className="muted">{T.noResults}</p>}
          {items.map((it) => (
            <div key={it.id} className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4 }}>
              {it.patientName && <b>{it.patientName}</b>}
              <div><b>{T.orderDate} {dateIn(it.orderDate, T.locale)}</b>{it.updated && <span className="lab-chip wait" style={{ marginLeft: 6 }}>{T.revisedChip(it.version)}</span>}</div>
              <div className="small">{T.listAppt(it.appointment ? it.appointment.when : it.request ? `${it.request.when}${T.waitSuffix}` : T.noApptShort)}</div>
              <div className="row">
                <button type="button" className="btn primary small" onClick={() => { if (!liff) return; setId(it.id); window.history.replaceState(null, "", `${window.location.pathname}?id=${encodeURIComponent(it.id)}`); openOne(liff, it.id); }}>{T.view}</button>
                <button type="button" className="btn ghost small" disabled={!!it.appointment} onClick={() => goBook(it.id)}>
                  {it.request ? T.changeRequest : T.choose}
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </main>
  );
}
