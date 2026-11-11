"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icons";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/**
 * ปุ่ม "ติดตั้งแอป" ในเมนู — ซ่อนเมื่อเปิดจากแอปที่ติดตั้งแล้ว
 * Android/Chrome/Edge: เปิดหน้าต่างติดตั้งของเบราว์เซอร์ · iPhone/iPad: Safari ไม่มีปุ่มติดตั้ง จึงบอกขั้นตอน "เพิ่มไปยังหน้าจอโฮม"
 * (iPhone ได้รับแจ้งเตือนเฉพาะเมื่อเปิดจากไอคอนบนหน้าจอโฮม iOS 16.4 ขึ้นไป)
 */
export function InstallApp() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [installed, setInstalled] = useState(true);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    setInstalled(isStandalone());
    setIos(isIos());
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as InstallPromptEvent); };
    const onInstalled = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  if (installed || (!prompt && !ios)) return null;

  async function install() {
    if (!prompt) { setHelp((v) => !v); return; }
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === "accepted") setInstalled(true);
    setPrompt(null);
  }

  return (
    <div className="install-app">
      <button type="button" className="btn ghost small nav-quick" onClick={install} aria-expanded={ios ? help : undefined}>
        <Icon name="download" size={16} />
        <span className="nav-label">ติดตั้งแอป DocDesk</span>
      </button>
      {ios && help && (
        <ol className="install-help small">
          <li>กดปุ่ม <b>แชร์</b> <span aria-hidden="true">(สี่เหลี่ยมมีลูกศรขึ้น)</span> ด้านล่างของ Safari</li>
          <li>เลือก <b>เพิ่มไปยังหน้าจอโฮม</b></li>
          <li>เปิด DocDesk จากไอคอนบนหน้าจอโฮม แล้วเปิด <b>แจ้งเตือนเครื่องนี้</b></li>
        </ol>
      )}
    </div>
  );
}
