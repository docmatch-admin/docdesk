-- ตั้งให้ Supabase เรียก /api/health ทุก 5 นาที
-- ก่อนรัน: แก้ YOUR-APP-URL และ YOUR-CRON-SECRET ให้ตรงกับ .env
-- ถ้าเปลี่ยน CRON_SECRET ต้องรันไฟล์นี้ใหม่ พร้อมกับ 003_fallback_cron.sql

select cron.unschedule('docdesk-health')
where exists (select 1 from cron.job where jobname = 'docdesk-health');

select cron.schedule(
  'docdesk-health',
  '*/5 * * * *',
  $$
  select net.http_get(
    url := 'https://YOUR-APP-URL/api/health',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR-CRON-SECRET'),
    timeout_milliseconds := 30000
  );
  $$
);
