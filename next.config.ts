import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp", "heic-convert", "heic-decode", "libheif-js"],
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

export default nextConfig;
