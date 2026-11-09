-- ระบบนัด: ตั้ง pg_cron 2 งาน (รันหลัง migration 036–040 และ deploy แอป/Edge Function แล้ว)
-- ค่าลับไม่อยู่ในไฟล์นี้: คัด CRON_SECRET เดิมจาก cron งาน docdesk-ai-fallback ไปเก็บใน Supabase Vault (docdesk_cron_secret)
-- แล้วทั้งสองงานอ่านจาก Vault ทุกครั้งที่รัน ถ้าเปลี่ยน CRON_SECRET ให้อัปเดต Vault ด้วย vault.update_secret
-- pg_cron ใช้เวลา UTC: 21:00 เวลาไทย = 14:00 UTC

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_secret text := (select substring(command from 'Bearer ([^'']+)') from cron.job where jobname = 'docdesk-ai-fallback');
  v_id uuid := (select id from vault.secrets where name = 'docdesk_cron_secret');
begin
  if v_secret is null then raise exception 'ไม่พบ CRON_SECRET ใน cron งาน docdesk-ai-fallback'; end if;
  if v_id is null then
    perform vault.create_secret(v_secret, 'docdesk_cron_secret', 'CRON_SECRET ของ DocDesk สำหรับ pg_cron');
  else
    perform vault.update_secret(v_id, v_secret);
  end if;
end $$;

-- 1) เตือนก่อนวันนัด 1 วัน: ทุก 15 นาที ส่งเมื่อถึง reminder_time (ตั้งในหน้าตั้งค่า → นัดหมาย)
--    เรียก Next.js route เพราะโค้ดส่ง LINE/Meta และบันทึกข้อความในแชทอยู่ที่แอป (ที่เดียวกับ cron เดิม)
select cron.unschedule('docdesk-appointment-reminders')
where exists (select 1 from cron.job where jobname = 'docdesk-appointment-reminders');

select cron.schedule(
  'docdesk-appointment-reminders',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://docdesk-tau.vercel.app/api/cron/appointment-reminders',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'docdesk_cron_secret')),
    timeout_milliseconds := 55000
  );
  $$
);

-- 2) มาตามนัด / ไม่มาตามนัด: ทุกวัน 21:00 เวลาไทย เรียก Edge Function mark-attendance
select cron.unschedule('docdesk-mark-attendance')
where exists (select 1 from cron.job where jobname = 'docdesk-mark-attendance');

select cron.schedule(
  'docdesk-mark-attendance',
  '0 14 * * *',
  $$
  select net.http_post(
    url := 'https://kbhhmjyipvnuyyveexpj.supabase.co/functions/v1/mark-attendance',
    headers := jsonb_build_object('x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'docdesk_cron_secret'), 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- ตรวจผล: select * from cron.job_run_details order by start_time desc limit 20;
--         select * from net._http_response order by created desc limit 20;
