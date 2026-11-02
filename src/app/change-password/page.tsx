import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { ChangePasswordForm } from "./change-password-form";

export default async function ChangePasswordPage() {
  const me = await getStaffContext();
  if (!me) redirect("/login");
  if (!me.mustChangePassword) redirect("/inbox");
  return <ChangePasswordForm name={me.displayName} />;
}
