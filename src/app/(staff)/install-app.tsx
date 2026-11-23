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

  const title = kind === "ios-steps" ? "ติดตั้ง DocDesk บน " + (platform.isIPad ? "iPad" : "iPhone")
    : kind === "open-external" ? (platform.isIOS ? "กรุณาเปิดลิงก์นี้ใน Safari" : "กรุณาเปิดลิงก์นี้ใน Chrome")
    : "ติดตั้ง DocDesk";

  return createPortal(
    <div className="install-sheet-wrap">
      <button type="button" className="install-sheet-backdrop" aria-label="ปิด" tabIndex={-1} onClick={onClose} />
      <div className={`install-sheet${platform.isIPad ? " ipad" : ""}`} role="dialog" aria-modal="true" aria-labelledby="install-sheet-title">
        <div className="install-sheet-head">
          <b id="install-sheet-title">{title}</b>
          <button ref={closeRef} type="button" className="icon-btn ghost" aria-label="ปิด" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        {kind === "ios-steps" && <IosSteps ipad={platform.isIPad} />}
        {kind === "open-external" && <OpenExternal platform={platform} />}
        {kind === "manual" && <ManualSteps />}
      </div>
      {/* ลูกศรกระพริบชี้ไปที่ปุ่มแชร์ของ Safari: iPhone อยู่แถบล่าง · iPad อยู่มุมขวาบน */}
      {kind === "ios-steps" && <div className={`install-arrow${platform.isIPad ? " up" : ""}`} aria-hidden="true">{platform.isIPad ? "⬆" : "⬇"}</div>}
    </div>,
    document.body,
  );
}

function IosSteps({ ipad }: { ipad: boolean }) {
  return (
    <ol className="install-steps">
      <li>
        <StepPic><ShareBarPic ipad={ipad} /></StepPic>
        <div><b>1. แตะปุ่มแชร์ ⬆️</b> {ipad ? "ที่มุมขวาบน" : "ที่แถบด้านล่าง"}ของ Safari
          <div className="muted small">ถ้าไม่เห็นปุ่มแชร์ ให้แตะ <b>•••</b> ก่อน</div></div>
      </li>
      <li>
        <StepPic><AddHomePic /></StepPic>
        <div><b>2. เลือก &ldquo;เพิ่มไปยังหน้าจอโฮม&rdquo;</b>
          <div className="muted small">ถ้าไม่เห็น ให้เลื่อนรายการลงด้านล่าง</div></div>
      </li>
      <li>
        <StepPic><AddButtonPic /></StepPic>
        <div><b>3. กด &ldquo;เพิ่ม&rdquo;</b> ที่มุมขวาบน
          <div className="muted small">จากนั้นเปิด DocDesk จากไอคอนบนหน้าจอโฮม แล้วเปิด <b>แจ้งเตือนเครื่องนี้</b></div></div>
      </li>
    </ol>
  );
}

function OpenExternal({ platform }: { platform: InstallPlatform }) {
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
    <div className="install-external">
      <p>{from ? `ตอนนี้เปิดอยู่ในแอป ${from} ซึ่ง` : "เบราว์เซอร์นี้"}ติดตั้ง DocDesk ไม่ได้ กรุณาเปิดลิงก์นี้ใน <b>{browser}</b> แล้วกดติดตั้งอีกครั้ง</p>
      <div className="install-url" aria-label="ลิงก์">{href}</div>
      <div className="install-external-actions">
        {open && <a className="btn primary" href={open}>เปิดใน {platform.inApp === "line" ? "เบราว์เซอร์" : browser}</a>}
        <button type="button" className={`btn ${open ? "ghost" : "primary"}`} onClick={copy}>{copied ? "คัดลอกแล้ว ✓" : "คัดลอกลิงก์"}</button>
      </div>
      <p className="muted small">
        {platform.isIOS
          ? <>คัดลอกลิงก์แล้วเปิดแอป <b>Safari</b> แตะช่องที่อยู่ด้านบน กดค้างแล้วเลือก <b>วาง</b></>
          : <>หรือแตะ <b>⋮</b> มุมขวาบน แล้วเลือก <b>เปิดใน Chrome</b> / <b>เปิดในเบราว์เซอร์</b></>}
      </p>
    </div>
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

/* ---------- รูปประกอบ (วาดเป็น SVG ใช้สีตามธีม) ---------- */

function StepPic({ children }: { children: React.ReactNode }) {
  return <div className="install-pic" aria-hidden="true">{children}</div>;
}

function ShareGlyph({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M-5 -1h-2v10h14V-1h-2M0 -9v11M-4 -5l4-4 4 4" />
    </g>
  );
}

function ShareBarPic({ ipad }: { ipad: boolean }) {
  // iPhone: แถบล่าง ปุ่มแชร์ตรงกลาง · iPad: แถบบน ปุ่มแชร์ขวา
  const barY = ipad ? 4 : 44;
  const icons = ipad ? [20, 40, 140] : [20, 50, 80, 110, 140];
  const share = ipad ? 140 : 80;
  return (
    <svg viewBox="0 0 160 72" width="160" height="72">
      <rect x="1" y="1" width="158" height="70" rx="10" className="pic-screen" />
      <rect x="1" y={barY} width="158" height="24" className="pic-bar" />
      {ipad && <rect x="56" y="9" width="60" height="14" rx="7" className="pic-field" />}
      {icons.map((x) => x === share
        ? <g key={x} className="pic-hl"><circle cx={x} cy={barY + 12} r="11" className="pic-ring" /><ShareGlyph x={x} y={barY + 12} s={0.85} /></g>
        : <rect key={x} x={x - 5} y={barY + 7} width="10" height="10" rx="2" className="pic-dim" />)}
    </svg>
  );
}

function AddHomePic() {
  return (
    <svg viewBox="0 0 160 72" width="160" height="72">
      <rect x="1" y="1" width="158" height="70" rx="10" className="pic-screen" />
      <rect x="10" y="8" width="140" height="16" rx="5" className="pic-bar" />
      <rect x="10" y="28" width="140" height="20" rx="5" className="pic-ring-rect" />
      <text x="18" y="42" className="pic-text">เพิ่มไปยังหน้าจอโฮม</text>
      <g className="pic-hl" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
        <rect x="129" y="31" width="14" height="14" rx="3" /><path d="M136 34.5v7M132.5 38h7" />
      </g>
      <rect x="10" y="52" width="140" height="14" rx="5" className="pic-bar" />
    </svg>
  );
}

function AddButtonPic() {
  return (
    <svg viewBox="0 0 160 72" width="160" height="72">
      <rect x="1" y="1" width="158" height="70" rx="10" className="pic-screen" />
      <text x="12" y="20" className="pic-text muted">ยกเลิก</text>
      <rect x="112" y="6" width="40" height="20" rx="6" className="pic-ring-rect" />
      <text x="132" y="20" textAnchor="middle" className="pic-text strong">เพิ่ม</text>
      <rect x="12" y="34" width="28" height="28" rx="7" className="pic-app" />
      <text x="26" y="53" textAnchor="middle" className="pic-app-text">D</text>
      <text x="50" y="52" className="pic-text">DocDesk</text>
    </svg>
  );
}
