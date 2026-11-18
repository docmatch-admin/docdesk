-- ผลแล็บ: pg_cron + pg_net เรียก Vercel route ชั่วโมงละครั้ง 13:00–18:00 เวลาไทยทุกวัน (แล็บส่งผลหลังเที่ยง)
-- pg_cron ใช้ UTC: 06:00–11:00 UTC = 13:00–18:00 น. · Vercel Hobby ทำ cron ถี่กว่าวันละครั้งไม่ได้
-- รันหลัง migration 061 และ deploy แอปแล้ว
-- ค่าลับไม่อยู่ในไฟล์นี้: ใส่ค่าเดียวกับ env LAB_SYNC_SECRET ของ Vercel ไว้ใน Vault ชื่อ LAB_SYNC_SECRET ก่อน เช่น
--   select vault.create_secret('<ค่าเดียวกับ Vercel>', 'LAB_SYNC_SECRET', 'secret ของ /api/cron/lab-results');
--   (เปลี่ยนค่า: select vault.update_secret((select id from vault.secrets where name = 'LAB_SYNC_SECRET'), '<ค่าใหม่>');)
-- ไม่ใช้ CRON_SECRET เดิม · แอปกันเรียกระบบแล็บถี่กว่า 15 นาทีอีกชั้น (เรียกซ้ำเร็วเกินจะข้ามโดยไม่แตะระบบแล็บ)

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'LAB_SYNC_SECRET') then
    raise exception 'ไม่พบ LAB_SYNC_SECRET ใน Vault — สร้างด้วย vault.create_secret ก่อน (ดูหัวไฟล์)';
  end if;
end $$;

select cron.unschedule('docdesk-lab-results')
where exists (select 1 from cron.job where jobname = 'docdesk-lab-results');

select cron.schedule(
  'docdesk-lab-results',
  '0 6-11 * * *',
  $$
  select net.http_post(
    url := 'https://docdesk-tau.vercel.app/api/cron/lab-results',
    headers := jsonb_build_object(
      'x-lab-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'LAB_SYNC_SECRET'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- ตรวจผล: select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'docdesk-lab-results') order by start_time desc limit 10;
--         select status_code, content from net._http_response order by created desc limit 10;
