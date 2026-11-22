import { AppShell } from "./app-shell";

// "/" = app shell เดียวกับ /start (แอปที่ติดตั้งก่อนหน้านี้ใช้ start_url "/") ไม่ redirect ฝั่ง server
export const dynamic = "force-static";

export default function Home() {
  return <AppShell />;
}
