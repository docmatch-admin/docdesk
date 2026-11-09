import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { InboxClient } from "./inbox-client";

export default async function InboxPage() {
  const me = await getStaffContext();
  if (!me) redirect("/login");
  // ห้องยาเข้าได้เฉพาะหน้านัดหมาย
  if (me.role === "pharmacy") redirect("/appointments");
  return <InboxClient me={{ id: me.id, role: me.role as "admin" | "agent", displayName: me.displayName, canViewSensitive: me.canViewSensitive, sensitiveAcked: me.sensitiveAcked }} />;
}
