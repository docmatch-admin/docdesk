import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { StaffClient } from "./staff-client";

export default async function StaffPage() {
  const me = await getStaffContext();
  if (me?.role !== "admin") redirect("/inbox");
  return <StaffClient meId={me.id} />;
}
