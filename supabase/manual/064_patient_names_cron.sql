-- นำเข้าชื่อคนไข้จากระบบใบเสร็จทุกคืน 02:00 เวลาไทย (= 19:00 UTC) ย้อนหลัง 3 วัน
-- รันหลัง migration 064 + ตั้ง env RCPT_PATIENT_TOKEN ใน Vercel · ใช้ค่าลับ docdesk_cron_secret ใน Vault (CRON_SECRET เดิม ไม่แก้)
select cron.unschedule('docdesk-patient-names')
where exists (select 1 from cron.job where jobname = 'docdesk-patient-names');

select cron.schedule(
  'docdesk-patient-names',
  '0 19 * * *',
  $$
  select net.http_post(
    url := 'https://docdesk-tau.vercel.app/api/cron/patient-names?days=3',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'docdesk_cron_secret'), 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- ตรวจผล: select status_code, content from net._http_response order by created desc limit 5;
