// แทน src/lib/supabase/server.ts ในเทสต์: ผู้ใช้ปัจจุบันตั้งผ่าน state.currentUser
import { state, supabaseAdmin } from "./admin.mjs";

export const supabaseServer = async () => ({
  auth: {
    getUser: async () => ({ data: { user: state.currentUser ?? null } }),
    updateUser: async ({ password }) => {
      if (state.updateUserError) return { error: state.updateUserError };
      state.passwordChanges.push({ id: state.currentUser.id, password });
      return { error: null };
    },
  },
  from: (name) => supabaseAdmin().from(name),
  rpc: (fn, args) => supabaseAdmin().rpc(fn, args),
});
