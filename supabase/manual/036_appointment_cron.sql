-- ระบบนัด: ตั้ง pg_cron 2 งาน (รันหลัง migration 036 และ deploy แล้ว)
-- ก่อนรัน: แก้ YOUR-APP-URL, YOUR-PROJECT-REF และ YOUR-CRON-SECRET (ค่าเดียวกับ CRON_SECRET ใน .env ของแอป)
-- pg_cron ใช้เวลา UTC: 21:00 เวลาไทย = 14:00 UTC

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1) เตือนก่อนวันนัด 1 วัน: ทุก 15 นาที ส่งเมื่อถึง reminder_time (ตั้งในหน้าตั้งค่า → นัดหมาย)
--    เรียก Next.js route เพราะโค้ดส่ง LINE/Meta และบันทึกข้อความในแชทอยู่ที่แอป (ที่เดียวกับ cron เดิม)
select cron.unschedule('docdesk-appointment-reminders')
where exists (select 1 from cron.job where jobname = 'docdesk-appointment-reminders');

select cron.schedule(
  'docdesk-appointment-reminders',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR-APP-URL/api/cron/appointment-reminders',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR-CRON-SECRET'),
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
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/mark-attendance',
    headers := jsonb_build_object('x-cron-secret', 'YOUR-CRON-SECRET', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- ตรวจผล: select * from cron.job_run_details order by start_time desc limit 20;
--         select * from net._http_response order by created desc limit 20;
