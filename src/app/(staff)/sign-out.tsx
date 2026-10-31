"use client";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";

export function SignOut() {
  const router = useRouter();
  return (
    <button
      className="btn ghost small"
      onClick={async () => {
        await supabaseBrowser().auth.signOut();
        router.replace("/login");
      }}
    >
      ออกจากระบบ
    </button>
  );
}
