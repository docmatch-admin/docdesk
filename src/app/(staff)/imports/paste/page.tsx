import { redirect } from "next/navigation";

/** ย้ายไปเป็นแท็บ "นำเข้าคำตอบ" ในหน้าฐานข้อมูล & คำตอบ */
export default function LegacyImportPage() {
  redirect("/knowledge?tab=import");
}
