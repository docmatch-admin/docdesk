"use client";

import { useEffect } from "react";
import { SW_SCOPE, SW_URL } from "@/lib/sw-url";

/** ลงทะเบียน service worker ทุกหน้า (ติดตั้งเป็นแอปได้ + เปิดแอปเร็ว + หน้าออฟไลน์) — ไม่ต้องรอผู้ใช้เปิดแจ้งเตือนก่อน
 * ที่อยู่เดิม /sw.js ใช้ scope เดียวกัน การลงทะเบียนนี้จึงแทนที่ตัวเดิมเอง (การสมัครแจ้งเตือนผูกกับ scope ยังอยู่ครบ) */
export function RegisterSW() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }).catch((e) => console.error("sw register failed", e));
  }, []);
  return null;
}
