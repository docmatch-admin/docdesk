// สร้างรูป splash iPhone: node scripts/make-splash.mjs → public/splash/*.png
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const { IPHONE_SCREENS, splashFile } = await import("../src/lib/startup-images.ts");
const BG = "#f4f6fa", BLUE = "#4a63e0", RED = "#e94b5c"; // --bg / --blue / --red ของ DocDesk
mkdirSync("public/splash", { recursive: true });
for (const [w, h, r] of IPHONE_SCREENS) {
  const W = w * r, H = h * r, icon = Math.round(96 * r), font = Math.round(30 * r);
  const top = Math.round(H / 2 - icon / 2 - 24 * r);
  const logo = await sharp("public/icons/icon-512.png").resize(icon, icon).png().toBuffer();
  const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${font * 2}">
    <text x="50%" y="${font * 1.3}" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-weight="700" font-size="${font}">
      <tspan fill="${BLUE}">Doc</tspan><tspan fill="${RED}">Desk</tspan></text></svg>`);
  await sharp({ create: { width: W, height: H, channels: 3, background: BG } })
    .composite([{ input: logo, top, left: Math.round((W - icon) / 2) }, { input: text, top: top + icon + Math.round(12 * r), left: 0 }])
    .png({ compressionLevel: 9, palette: true }).toFile(`public${splashFile(w, h, r)}`);
  console.log(splashFile(w, h, r));
}
