import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans_Thai } from "next/font/google";
import "./globals.css";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import { IOS_STARTUP_IMAGES } from "@/lib/startup-images";
import { RegisterSW } from "./register-sw";

// ฟอนต์เก็บในเว็บเราเอง (build ลง _next/static) ไม่ต้องรอเซิร์ฟเวอร์ฟอนต์ของ Google ตอนเปิดแอป และ service worker เก็บไว้ได้
const plex = IBM_Plex_Sans_Thai({ subsets: ["thai", "latin"], weight: ["400", "500", "600"], display: "swap", variable: "--font-plex" });

export const metadata: Metadata = {
  title: "DocDesk",
  description: "รวมแชททุกช่องทาง + AI ผู้ช่วยตอบ",
  manifest: "/manifest.webmanifest",
  applicationName: "DocDesk",
  // ติดตั้งเป็นแอปบน iPhone/iPad (เพิ่มไปที่หน้าจอโฮม) · เปิดเต็มจอไม่มีแถบ Safari
  // startupImage: จอ splash ตอนเปิดจากไอคอนบน iPhone (โลโก้ DocDesk แทนจอขาว)
  appleWebApp: { capable: true, title: "DocDesk", statusBarStyle: "default", startupImage: IOS_STARTUP_IMAGES },
  formatDetection: { telephone: false },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }, { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

// viewport-fit=cover ให้แถบล่างเว้นขอบจอ iPhone (safe-area) · สีแถบสถานะตามธีม
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Android: คีย์บอร์ดขึ้นแล้วย่อหน้าเว็บ ช่องพิมพ์ไม่ถูกบัง (iOS จัดการใน useMobileTyping)
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6fa" },
    { media: "(prefers-color-scheme: dark)", color: "#12151c" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // ธีม ขนาดตัวอักษร ย่อเมนู ของผู้ใช้ (cookie จากหมวด "การแสดงผล") ใส่ที่ <html> ด้วยสคริปต์ใน <head> ก่อนวาดหน้า ไม่มีจอกะพริบสีผิด
  // ไม่อ่าน cookie ฝั่ง server เพื่อให้หน้า app shell (/start) เป็นไฟล์ static เปิดจาก service worker ได้ทันที
  // "ตามระบบ" ไม่ใส่ data-theme ให้ CSS ตาม prefers-color-scheme
  return (
    // หน้าที่เปิดอยู่เปลี่ยนแอตทริบิวต์เองเมื่อผู้ใช้เปลี่ยนค่า (ทุกเครื่อง sync ผ่าน realtime)
    <html lang="th" suppressHydrationWarning className={plex.variable}>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{children}<RegisterSW /></body>
    </html>
  );
}
