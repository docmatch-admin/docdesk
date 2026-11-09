-- Edge Function ที่ pg_cron เรียก (mark-attendance) ตรวจ x-cron-secret กับค่าใน Supabase Vault ชื่อ docdesk_cron_secret
-- ค่าใน Vault สร้างใน supabase/manual/036_appointment_cron.sql จากค่า CRON_SECRET เดิมของ cron งานอื่น
create or replace function verify_cron_secret(p_secret text) returns boolean
language sql stable security definer set search_path = public, vault as $$
  select coalesce(p_secret, '') <> '' and exists (
    select 1 from vault.decrypted_secrets where name = 'docdesk_cron_secret' and decrypted_secret = p_secret
  );
$$;
revoke all on function verify_cron_secret(text) from public, anon, authenticated;
grant execute on function verify_cron_secret(text) to service_role;
