import type { Metadata } from "next";
import { LabResultViewer } from "./viewer";

export const metadata: Metadata = { title: "ผลแล็บ", robots: { index: false, follow: false } };

/** หน้าคนไข้เปิดผลแล็บผ่าน LIFF (ปุ่ม "ดูผล" ในข้อความ LINE) — ต้องเป็นบัญชี LINE ที่ผูกกับ HN ของผลนั้น */
export default function LabResultPage() {
  return <LabResultViewer liffId={process.env.NEXT_PUBLIC_LINE_LIFF_ID ?? ""} />;
}
