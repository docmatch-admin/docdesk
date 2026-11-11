import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { htmlAttrs } from "@/lib/theme";
import { RegisterSW } from "./register-sw";

export const metadata: Metadata = {
  title: "DocDesk",
  description: "รวมแชททุกช่องทาง + AI ผู้ช่วยตอบ",
  manifest: "/manifest.webmanifest",
  applicationName: "DocDesk",
  // ติดตั้งเป็นแอปบน iPhone/iPad (เพิ่มไปที่หน้าจอโฮม) · เปิดเต็มจอไม่มีแถบ Safari
  appleWebApp: { capable: true, title: "DocDesk", statusBarStyle: "default" },
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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6fa" },
    { media: "(prefers-color-scheme: dark)", color: "#12151c" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // ธีม ขนาดตัวอักษร ย่อเมนู ของผู้ใช้ (cookie จากหมวด "การแสดงผล") ใส่ที่ <html> ตั้งแต่ฝั่ง server ไม่มีจอกะพริบสีผิด
  // "ตามระบบ" ไม่ใส่ data-theme ให้ CSS ตาม prefers-color-scheme
  const jar = await cookies();
  const attrs = htmlAttrs((name) => jar.get(name)?.value);
  return (
    // หน้าที่เปิดอยู่เปลี่ยนแอตทริบิวต์เองเมื่อผู้ใช้เปลี่ยนค่า (ทุกเครื่อง sync ผ่าน realtime)
    <html lang="th" suppressHydrationWarning {...attrs}>
      <head>
        <meta name="color-scheme" content="light dark" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}<RegisterSW /></body>
    </html>
  );
}
