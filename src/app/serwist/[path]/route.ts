// สร้าง service worker ตอน build (Serwist + Turbopack) เสิร์ฟที่ /serwist/sw.js
import { spawnSync } from "node:child_process";
import { createSerwistRoute } from "@serwist/turbopack";

// revision ของหน้า shell ต้องเหมือนกันทุกครั้งที่ route นี้ถูกเรียกใน build เดียวกัน → ใช้ commit
const revision = process.env.VERCEL_GIT_COMMIT_SHA
  || spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout?.trim()
  || "dev";

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } = createSerwistRoute({
  swSrc: "src/app/sw.ts",
  // _next/static (JS/CSS/ฟอนต์ที่ build แล้ว) + ไอคอน + หน้าออฟไลน์ · ไม่รวมไฟล์อื่นใน public (หน้า legal, widget ของเว็บคลินิก)
  globPatterns: [
    ".next/static/**/*.{js,css,woff2,png,svg,ico,webp}",
    "public/icons/*.png",
    "public/offline.html",
    "public/manifest.webmanifest",
  ],
  // app shell: เปิดจากไอคอนแล้วขึ้นทันที (หน้าไม่มีข้อมูลคนไข้ เช็ก session ฝั่ง client)
  additionalPrecacheEntries: [
    { url: "/start", revision },
    { url: "/", revision },
  ],
  // ไฟล์ splash iPhone ใหญ่ ไม่ต้อง precache (iOS โหลดเองตอนติดตั้ง)
  maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
});
