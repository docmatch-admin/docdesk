import type { NextConfig } from "next";
import { withSerwist } from "@serwist/turbopack";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp", "heic-convert", "heic-decode", "libheif-js"],
  // หน้านโยบายสำหรับ Meta App Review เป็นไฟล์ static ไม่ผ่าน layout ของเจ้าหน้าที่ จึงเปิดได้โดยไม่ล็อกอิน
  async rewrites() {
    return [
      { source: "/privacy", destination: "/legal/privacy.html" },
      { source: "/terms", destination: "/legal/terms.html" },
      { source: "/data-deletion", destination: "/legal/data-deletion.html" },
    ];
  },
  async headers() {
    return [
      {
        // widget script & chat page are embedded on happiwellclinic.com
        source: "/(widget.js|chat-embed)",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
};

// withSerwist: ให้ esbuild (ใช้ build service worker ใน src/app/serwist/[path]/route.ts) ไม่ถูก bundle
export default withSerwist(nextConfig);
