import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { PasteClient } from "./paste-client";

export default async function PasteImportPage() {
  const me = await getStaffContext();
  if (me?.role !== "admin") redirect("/inbox");
  return <PasteClient />;
}
