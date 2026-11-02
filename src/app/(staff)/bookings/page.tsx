import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { BookingsClient } from "./bookings-client";

export default async function BookingsPage() {
  const me = await getStaffContext();
  if (!me) redirect("/login");
  return <BookingsClient />;
}
