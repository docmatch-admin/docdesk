import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { InboxClient } from "./inbox-client";

export default async function InboxPage() {
  const me = await getStaffContext();
  if (!me) redirect("/login");
  return <InboxClient me={{ id: me.id, role: me.role, displayName: me.displayName, canViewSensitive: me.canViewSensitive, sensitiveAcked: me.sensitiveAcked }} />;
}
