"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePwaInstall } from "@/hooks/use-pwa-install";
import {
  externalOpenUrl, installAction, INSTALL_SNOOZE_KEY, isSnoozed, showInstallBanner, snoozeUntil, type InstallPlatform,
} from "@/lib/pwa-install";
import { Icon } from "./icons";

type Sheet = "ios-steps" | "open-external" | "manual" | null;

/** เปิดแผ่นวิธีติดตั้งจากที่อื่น (เช่น ปุ่มแจ้งเตือนบน iPhone ที่ยังไม่ติดตั้ง) */
export function useInstallFlow() {
  const pwa = usePwaInstall();
  const [sheet, setSheet] = useState<Sheet>(null);
  const sheetEl = sheet && <InstallSheet kind={sheet} platform={pwa.platform} onClose={() => setSheet(null)} />;
  return { pwa, openSheet: setSheet, sheetEl };
}

/** กดติดตั้ง: Android/คอม เปิดหน้าต่างติดตั้งของเบราว์เซอร์ · iPhone/iPad และแอปอื่น (LINE ฯลฯ) เปิดแผ่นวิธีทำ */
function useInstall() {
  const { pwa, openSheet, sheetEl } = useInstallFlow();
  const action = installAction(pwa);
  async function install() {
    if (action === "installed") return;
    if (action === "prompt") {
      // ผู้ใช้กดยกเลิก หรือเบราว์เซอร์ไม่ให้เปิดซ้ำ → บอกวิธีติดตั้งจากเมนูเบราว์เซอร์แทน
      if ((await pwa.promptInstall()) === "unavailable") openSheet("manual");
      return;
    }
    openSheet(action);
  }
  return { pwa, install, sheetEl };
}

/**
 * รายการ "ติดตั้ง DocDesk" ในหน้าเมนูมือถือ และหน้าตั้งค่า (เผื่อกด "ไว้ทีหลัง" ที่แบนเนอร์)
 * แสดงเฉพาะตอนที่ยังไม่ได้ติดตั้ง — ติดตั้งแล้ว (หรือยังเช็กไม่เสร็จ) ไม่แสดง (เจ้าของสั่ง 23 พ.ย. 2026)
 * (iPhone ได้รับแจ้งเตือนเฉพาะเมื่อเปิดจากไอคอนบนหน้าจอโฮม iOS 16.4 ขึ้นไป)
 */
export function InstallApp({ variant = "nav" }: { variant?: "nav" | "settings" }) {
  const { pwa, install, sheetEl } = useInstall();
  if (!pwa.ready || pwa.isInstalled) return null;
  return (
    <div className="install-app">
      <button type="button" className={variant === "nav" ? "btn ghost small nav-quick install-btn" : "btn small"} onClick={install}
        aria-haspopup={pwa.canPrompt ? undefined : "dialog"}>
        <Icon name="download" size={16} />
        <span className="nav-label">ติดตั้ง DocDesk</span>
      </button>
      {sheetEl}
    </div>
  );
}

/** แถว "ติดตั้ง DocDesk" ในหน้าตั้งค่า: แสดงเฉพาะเครื่องที่ยังไม่ได้ติดตั้ง */
export function useShowInstallItem() {
  const pwa = usePwaInstall();
  return pwa.ready && !pwa.isInstalled;
}

/** แบนเนอร์ด้านบนหลังล็อกอิน จนกว่าจะติดตั้ง · "ไว้ทีหลัง" ซ่อน 7 วัน (แสดงผ่าน StaffBanners ใน push-control) */
export function useInstallBanner() {
  const { pwa, install, sheetEl } = useInstall();
  const [snoozed, setSnoozed] = useState(true);
  useEffect(() => {
    try { setSnoozed(isSnoozed(localStorage.getItem(INSTALL_SNOOZE_KEY), Date.now())); } catch { setSnoozed(false); }
  }, []);

  function later() {
    setSnoozed(true);
    try { localStorage.setItem(INSTALL_SNOOZE_KEY, snoozeUntil(Date.now())); } catch { /* private mode: ซ่อนแค่รอบนี้ */ }
  }

  const show = pwa.ready && showInstallBanner({ ...pwa, snoozed });
  const element = show && (
    <div className="install-banner" role="region" aria-label="ติดตั้งแอป">
      <span className="install-banner-icon" aria-hidden="true"><Icon name="download" size={18} /></span>
      <span className="install-banner-text">ติดตั้ง DocDesk ไว้บนหน้าจอ เปิดใช้ได้ทันที</span>
      <span className="install-banner-actions">
        <button type="button" className="btn primary small" onClick={install}>ติดตั้ง</button>
        <button type="button" className="btn ghost small" onClick={later}>ไว้ทีหลัง</button>
      </span>
    </div>
  );
  return { show, element, sheetEl };
}

/* ---------- แผ่นวิธีติดตั้ง (เลื่อนขึ้นจากด้านล่าง) ---------- */

function InstallSheet({ kind, platform, onClose }: { kind: Exclude<Sheet, null>; platform: InstallPlatform; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isSteps = kind === "ios-steps";
  return createPortal(
    <div className="install-sheet-wrap">
      <button type="button" className="install-sheet-backdrop" aria-label="ปิด" tabIndex={-1} onClick={onClose} />
      <section className={`install-sheet ${kind}${platform.isIPad ? " ipad" : ""}`} role="dialog" aria-modal="true" aria-labelledby="install-sheet-title">
        {kind === "open-external" ? (
          <OpenExternal platform={platform} onClose={onClose} closeRef={closeRef} />
        ) : (
          <>
            <div className="install-grip" aria-hidden="true" />
            <div className="install-head">
              <div className="install-app-icon" aria-hidden="true">D</div>
              <div className="install-head-text">
                <h1 id="install-sheet-title">ติดตั้ง DocDesk ไว้บนหน้าจอ</h1>
                <span>ทำครั้งเดียว ต่อไปแตะไอคอนเปิดได้เลย</span>
              </div>
              <button ref={closeRef} type="button" className="install-x" aria-label="ปิด" onClick={onClose}><Icon name="x" size={22} /></button>
            </div>
            {isSteps ? <IosSteps ipad={platform.isIPad} /> : <ManualSteps />}
            <button type="button" className="install-later" onClick={onClose}>ไว้ทีหลัง</button>
          </>
        )}
      </section>
      {/* ลูกศรกระพริบชี้ไปที่ปุ่มแชร์ของ Safari: iPhone อยู่แถบล่าง · iPad อยู่มุมขวาบน */}
      {isSteps && (
        <div className={`install-arrow${platform.isIPad ? " up" : ""}`} aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d={platform.isIPad ? "M12 20V5M6 11l6-6 6 6" : "M12 4v15M6 13l6 6 6-6"} /></svg>
        </div>
      )}
    </div>,
    document.body,
  );
}

const SHARE_PATH = "M12 3v12M7 8l5-5 5 5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7";

/** ขั้นตอนตามแบบ: เลขในวงกลม · คำสั่งสั้น · รูปปุ่มที่ต้องแตะด้านขวา */
function IosSteps({ ipad }: { ipad: boolean }) {
  return (
    <ol className="install-steps">
      <li>
        <span className="install-num">1</span>
        <span className="install-text">แตะปุ่ม <b>แชร์</b> {ipad ? "ที่มุมขวาบน" : "ที่แถบด้านล่าง"}</span>
        <span className="install-pic share" aria-hidden="true"><svg viewBox="0 0 24 24"><path d={SHARE_PATH} /></svg></span>
      </li>
      <li>
        <span className="install-num">2</span>
        <span className="install-text">เลื่อนลง แล้วแตะ</span>
        <span className="install-pic chip" aria-hidden="true">เพิ่มไปยังหน้าจอโฮม<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M12 8v8M8 12h8" /></svg></span>
      </li>
      <li>
        <span className="install-num">3</span>
        <span className="install-text">แตะ <b>เพิ่ม</b> มุมขวาบน</span>
        <span className="install-pic add" aria-hidden="true">เพิ่ม</span>
      </li>
    </ol>
  );
}

function OpenExternal({ platform, onClose, closeRef }: { platform: InstallPlatform; onClose: () => void; closeRef: React.RefObject<HTMLButtonElement | null> }) {
  const [href, setHref] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { setHref(window.location.origin + window.location.pathname); }, []);
  const open = href ? externalOpenUrl(href, platform) : null;
  const browser = platform.isIOS ? "Safari" : "Chrome";
  const from = platform.inApp === "line" ? "LINE" : platform.inApp === "facebook" ? "Facebook" : platform.inApp === "instagram" ? "Instagram" : null;

  async function copy() {
    let ok = false;
    try { await navigator.clipboard.writeText(href); ok = true; } catch {
      // webview บางตัวไม่มี clipboard API
      try {
        const t = document.createElement("textarea");
        t.value = href; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
        document.body.appendChild(t); t.select(); ok = document.execCommand("copy"); t.remove();
      } catch { ok = false; }
    }
    setCopied(ok);
  }

  return (
    <>
      <div className="install-compass" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5l-2 5-5 2 2-5z" /></svg></div>
      <div className="install-ext-text">
        <h1 id="install-sheet-title">กรุณาเปิดใน {browser}</h1>
        <p>ตอนนี้เปิดจาก{from ? `แอป ${from}` : "เบราว์เซอร์นี้"}อยู่ ซึ่งติดตั้งลงหน้าจอไม่ได้ คัดลอกลิงก์ไปวางใน {browser} แล้วทำตามขั้นตอนต่อได้เลยค่ะ</p>
      </div>
      <div className="install-url">
        <span aria-label="ลิงก์">{href}</span>
        <button ref={closeRef} type="button" onClick={copy}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
          {copied ? "คัดลอกแล้ว ✓" : "คัดลอกลิงก์"}
        </button>
      </div>
      {open && <a className="install-open" href={open}>เปิดใน {platform.inApp === "line" ? "เบราว์เซอร์" : browser}</a>}
      <div className="install-tip">
        {platform.isIOS
          ? <>{from === "LINE" || !from ? <>ใน LINE: แตะ <b>⋯</b> มุมขวาบน แล้วเลือก <b>เปิดในเบราว์เซอร์อื่น</b> ก็ได้ค่ะ</> : <>หรือเปิด <b>Safari</b> แตะช่องที่อยู่ด้านบน กดค้างแล้วเลือก <b>วาง</b></>}</>
          : <>หรือแตะ <b>⋮</b> มุมขวาบน แล้วเลือก <b>เปิดใน Chrome</b> / <b>เปิดในเบราว์เซอร์</b></>}
      </div>
      <button type="button" className="install-later" onClick={onClose}>ใช้ต่อแบบนี้ไปก่อน</button>
    </>
  );
}

function ManualSteps() {
  return (
    <div className="install-external">
      <ol className="install-help">
        <li>Chrome / Edge: กดไอคอนติดตั้ง <span aria-hidden="true">⊕</span> ท้ายช่องที่อยู่ หรือเปิดเมนู <b>⋮</b> / <b>…</b> แล้วเลือก <b>ติดตั้ง DocDesk</b> (Edge: <b>แอป → ติดตั้งไซต์นี้เป็นแอป</b>)</li>
        <li>Safari บน Mac: เมนู <b>ไฟล์ → เพิ่มไปยัง Dock</b></li>
      </ol>
      <p className="muted small">ถ้าติดตั้งไว้แล้ว ให้เปิด DocDesk จากไอคอนแอปบนเครื่อง · Firefox ยังติดตั้งเป็นแอปไม่ได้ ให้ใช้ Chrome หรือ Edge</p>
    </div>
  );
}
