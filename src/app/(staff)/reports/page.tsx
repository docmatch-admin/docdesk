import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { ReportsClient } from "./reports-client";

export default async function ReportsPage() {
  if ((await getStaffContext())?.role !== "admin") redirect("/inbox");
  return <ReportsClient />;
}
