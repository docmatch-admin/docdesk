import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { SettingsClient } from "./settings-client";

export default async function SettingsPage() {
  if ((await getStaffContext())?.role !== "admin") redirect("/inbox");
  return <SettingsClient />;
}
