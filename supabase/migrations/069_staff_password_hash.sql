-- ตั้งรหัสผ่านของบัญชีเจ้าหน้าที่ด้วย bcrypt hash จาก HR (POST /api/hr/credentials)
-- Supabase Auth รับ password_hash เฉพาะ admin createUser · ตอน updateUserById เพิกเฉยเงียบ ๆ (ตอบ ok แต่รหัสไม่เปลี่ยน)
-- จึงเขียน auth.users.encrypted_password ตรงด้วยฟังก์ชันนี้ · เรียกได้เฉพาะ service_role
create or replace function public.set_staff_password_hash(p_user uuid, p_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_hash !~ '^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$' then return false; end if;
  update auth.users set encrypted_password = p_hash, updated_at = now() where id = p_user;
  return found;
end $$;

revoke all on function public.set_staff_password_hash(uuid, text) from public, anon, authenticated;
grant execute on function public.set_staff_password_hash(uuid, text) to service_role;
