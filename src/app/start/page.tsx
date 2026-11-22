import { AppShell } from "../app-shell";

// start_url ของแอปที่ติดตั้ง (/start?source=pwa): static ล้วน ไม่มี redirect ไม่รอ server
export const dynamic = "force-static";

export default function StartPage() {
  return <AppShell />;
}
