import sharp from "sharp";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_WEB_IMAGE_BYTES = 5 * 1024 * 1024;
const MAIN_SIZE = 1600;
const PREVIEW_SIZE = 240;
/** กันไฟล์เล็กที่ขยายแล้วกินหน่วยความจำมหาศาล */
const MAX_INPUT_PIXELS = 100_000_000;

export class MediaError extends Error {
  code: "unsupported" | "too_large" | "corrupt";
  constructor(code: MediaError["code"]) {
    super(code);
    this.code = code;
  }
}

export type ImageKind = "jpeg" | "png" | "webp" | "heic";

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/** ดูจาก magic bytes ไม่เชื่อนามสกุลหรือ Content-Type */
export function detectImageType(buf: Buffer): ImageKind | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.toString("latin1", 4, 8) === "ftyp" && HEIC_BRANDS.has(buf.toString("latin1", 8, 12))) return "heic";
  return null;
}

export interface ProcessedImage { main: Buffer; preview: Buffer; width: number; height: number }

/** แปลงเป็น JPEG ทุกแบบ และตัด EXIF เช่นพิกัด GPS ออก */
export async function processImage(input: Buffer, maxBytes = MAX_IMAGE_BYTES): Promise<ProcessedImage> {
  if (input.length > maxBytes) throw new MediaError("too_large");
  const kind = detectImageType(input);
  if (!kind) throw new MediaError("unsupported");

  try {
    // sharp รุ่นสำเร็จรูปถอดรหัส HEIC จากมือถือไม่ได้ ต้องแปลงเป็น JPEG ก่อน
    let source = input;
    if (kind === "heic") {
      const { default: convert } = await import("heic-convert");
      source = Buffer.from(await convert({ buffer: input, format: "JPEG", quality: 0.92 }));
    }
    const resized = (size: number) =>
      sharp(source, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" });
    const main = await resized(MAIN_SIZE).jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
    const preview = await resized(PREVIEW_SIZE).jpeg({ quality: 70 }).toBuffer();
    return { main: main.data, preview, width: main.info.width, height: main.info.height };
  } catch (e) {
    console.error("process image failed", e);
    throw new MediaError("corrupt");
  }
}

/** ดาวน์โหลดโดยหยุดทันทีเมื่อเกินขนาด ไม่โหลดไฟล์ใหญ่เข้าหน่วยความจำทั้งก้อน */
export async function downloadLimited(url: string, headers: Record<string, string> = {}, maxBytes = MAX_IMAGE_BYTES): Promise<Buffer> {
  if (!url.startsWith("https://")) throw new Error("media url must be https");
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok || !res.body) throw new Error(`media download failed ${res.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > maxBytes) throw new MediaError("too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
