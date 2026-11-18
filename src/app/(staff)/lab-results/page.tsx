import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { LabResultsClient } from "./lab-results-client";

/** ผลแล็บจากแล็บนอก: เจ้าหน้าที่ที่อ่านแชทได้ (ไม่รวมห้องยา) */
export default async function LabResultsPage({ searchParams }: { searchParams: Promise<{ id?: string; tab?: string }> }) {
  const me = await getStaffContext();
  if (!me || me.role === "pharmacy") redirect("/appointments");
  const sp = await searchParams;
  return <LabResultsClient isAdmin={me.role === "admin"} initialId={sp.id ?? null} initialTab={sp.tab ?? null} />;
}
