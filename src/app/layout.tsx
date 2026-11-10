import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { htmlAttrs } from "@/lib/theme";

export const metadata: Metadata = {
  title: "DocDesk",
  description: "รวมแชททุกช่องทาง + AI ผู้ช่วยตอบ",
  manifest: "/manifest.webmanifest",
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
      <body>{children}</body>
    </html>
  );
}
