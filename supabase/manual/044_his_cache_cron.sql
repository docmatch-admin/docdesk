-- cache iService และ mark-attendance แบบลองใหม่ทุกชั่วโมง (รันหลัง migration 044 และ deploy Edge Function)
-- ใช้ค่าลับ docdesk_cron_secret ใน Vault ที่ตั้งไว้แล้วจาก 036_appointment_cron.sql (ไฟล์นี้ไม่แก้ Vault)
-- pg_cron ใช้เวลา UTC: 08:00–18:59 เวลาไทย = 01:00–11:59 UTC

-- 1) ดึง visit วันนี้เก็บ cache ทุก 5 นาทีในเวลาทำการ (ลบ cache เก่ากว่า 90 วันในงานเดียวกัน)
select cron.unschedule('docdesk-his-visit-cache')
where exists (select 1 from cron.job where jobname = 'docdesk-his-visit-cache');

select cron.schedule(
  'docdesk-his-visit-cache',
  '*/5 1-11 * * *',
  $$
  select net.http_post(
    url := 'https://kbhhmjyipvnuyyveexpj.supabase.co/functions/v1/iservice',
    headers := jsonb_build_object('x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'docdesk_cron_secret'), 'Content-Type', 'application/json'),
    body := '{"action":"refresh"}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- 2) mark-attendance ทุกชั่วโมง: วันนี้ตัดสินหลัง 21:00 ไทย วันก่อนหน้าที่ดึง visit ไม่ได้ลองใหม่จนสำเร็จ (ย้อนหลัง 7 วัน)
select cron.unschedule('docdesk-mark-attendance')
where exists (select 1 from cron.job where jobname = 'docdesk-mark-attendance');

select cron.schedule(
  'docdesk-mark-attendance',
  '0 * * * *',
  $$
  select net.http_post(
    url := 'https://kbhhmjyipvnuyyveexpj.supabase.co/functions/v1/mark-attendance',
    headers := jsonb_build_object('x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'docdesk_cron_secret'), 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
