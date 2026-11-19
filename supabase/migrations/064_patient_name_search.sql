-- 064: ค้นคนไข้ด้วยชื่อตอนทำนัด — ชื่อจากระบบใบเสร็จ (happiwell-ai) นำเข้าทุกคืนด้วย /api/cron/patient-names
-- 1) ที่มาของชื่อ: 'receipt' = มาจากระบบใบเสร็จ (เขียนทับได้ครั้งหน้า) · null = iService / เจ้าหน้าที่ / ระบบอื่น (ห้ามทับ)
alter table patients add column if not exists name_source text;
alter table patients add column if not exists name_synced_at timestamptz;

-- ใครก็ตามที่แก้ชื่อโดยไม่ได้แตะ name_synced_at (เช่น ผูก HN แล้วได้ชื่อจาก iService) → ไม่ใช่ชื่อจากใบเสร็จแล้ว
create or replace function patients_name_source_trigger()
returns trigger language plpgsql as $$
begin
  if new.full_name is distinct from old.full_name and new.name_synced_at is not distinct from old.name_synced_at then
    new.name_source := null;
  end if;
  return new;
end
$$;
drop trigger if exists patients_name_source on patients;
create trigger patients_name_source before update on patients
  for each row execute function patients_name_source_trigger();

-- 2) ilike '%คำ%' ใช้ index trigram ได้ (ค้นชื่ออย่างเดียว / นามสกุลอย่างเดียว / ทั้งคู่)
create extension if not exists pg_trgm with schema extensions;
create index if not exists patients_full_name_trgm on patients using gin (full_name extensions.gin_trgm_ops);
