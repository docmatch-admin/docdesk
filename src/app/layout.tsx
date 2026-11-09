import type { Metadata } from "next";
import "./globals.css";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: "DocDesk",
  description: "รวมแชททุกช่องทาง + AI ผู้ช่วยตอบ",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme ใส่โดยสคริปต์ก่อน hydrate (ธีมที่เลือกเอง) จึงต่างจาก HTML ฝั่งเซิร์ฟเวอร์ได้
    <html lang="th" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
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
