import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { PrintClient } from "./print-client";

export default async function PrintAppointmentPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ msg?: string; sent?: string; reprint?: string }>;
}) {
  const me = await getStaffContext();
  if (!me) redirect("/login");
  const { id } = await params;
  const { msg, sent, reprint } = await searchParams;
  return <PrintClient id={id} message={msg ?? ""} sent={sent === "1"} autoPrint={msg !== undefined || reprint === "1"} />;
}
