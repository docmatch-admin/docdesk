import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { KnowledgeClient } from "./knowledge-client";

export default async function KnowledgePage() {
  if ((await getStaffContext())?.role !== "admin") redirect("/inbox");
  return <KnowledgeClient />;
}
