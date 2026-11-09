import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { AppointmentsClient } from "./appointments-client";

export default async function AppointmentsPage() {
  const me = await getStaffContext();
  if (!me) redirect("/login");
  return <AppointmentsClient canOpenChat={me.role !== "pharmacy"} />;
}
