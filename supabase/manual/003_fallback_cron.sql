-- ตั้งให้ Supabase เรียก /api/cron/fallback ทุก 1 นาที (โหมด "คนตอบก่อน")
-- ใช้แทน Vercel Cron (แผนฟรีของ Vercel รันได้แค่วันละครั้ง)
-- ก่อนรัน: แก้ YOUR-APP-URL และ YOUR-CRON-SECRET ให้ตรงกับ .env

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('docdesk-ai-fallback')
where exists (select 1 from cron.job where jobname = 'docdesk-ai-fallback');

select cron.schedule(
  'docdesk-ai-fallback',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR-APP-URL/api/cron/fallback',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR-CRON-SECRET')
  );
  $$
);
