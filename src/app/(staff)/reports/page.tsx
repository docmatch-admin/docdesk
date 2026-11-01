import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { ReportsTabs } from "./reports-tabs";

export default async function ReportsPage() {
  const me = await getStaffContext();
  if (!me) redirect("/login");
  return <ReportsTabs meId={me.id} isAdmin={me.role === "admin"} />;
}
