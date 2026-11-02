import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { ImportsClient } from "./imports-client";

export default async function ImportsPage() {
  const me = await getStaffContext();
  if (me?.role !== "admin") redirect("/inbox");
  return <ImportsClient />;
}
