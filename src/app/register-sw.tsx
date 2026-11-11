"use client";

import { useEffect } from "react";

/** ลงทะเบียน service worker ทุกหน้า (ให้ติดตั้งเป็นแอปได้ + หน้าออฟไลน์) — ไม่ต้องรอผู้ใช้เปิดแจ้งเตือนก่อน */
export function RegisterSW() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((e) => console.error("sw register failed", e));
  }, []);
  return null;
}
