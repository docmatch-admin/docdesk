-- ขีดว่า "มาแล้ว" อัตโนมัติ: เมื่อ visit ของ HN ถูกบันทึกลง his_visit_cache (cron ดึงทุก 5 นาที หรือเมื่อเปิดหน้าทำนัด)
-- นัดวันเดียวกันที่ยังเปิดอยู่ → attended + เก็บเวลาลงทะเบียน visit ไม่ต้องรอ mark-attendance ตอน 21:00
-- (mark-attendance ยังทำงานเหมือนเดิม สำหรับตัดสิน no_show)

alter table appointments add column if not exists arrived_time text;

create or replace function mark_arrived_from_visit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_hn text := nullif(ltrim(trim(new.hn), '0'), '');
  v_time text := nullif(substring(coalesce(new.visit_time, '') from '^\d{1,2}:\d{2}'), '');
  r record;
begin
  if v_hn is null then return new; end if;
  for r in
    update appointments a
       set status = 'attended', arrived_time = coalesce(a.arrived_time, v_time), updated_at = now()
     where a.appoint_date = new.visit_date
       and a.status in ('scheduled', 'confirmed', 'reschedule_requested')
       and coalesce(a.series_done, false) = false
       and a.hn is not null
       and ltrim(trim(a.hn), '0') = v_hn
    returning a.id
  loop
    insert into appointment_events (appointment_id, kind, actor, detail)
    values (r.id, 'attended', 'system', jsonb_build_object('source', 'visit', 'vn', new.vn, 'visit_time', v_time));
  end loop;
  return new;
end $$;

drop trigger if exists his_visit_cache_mark_arrived on his_visit_cache;
create trigger his_visit_cache_mark_arrived
  after insert or update of visit_date, hn on his_visit_cache
  for each row execute function mark_arrived_from_visit();

-- ย้อนให้นัดวันนี้ที่คนไข้มาแล้ว (visit อยู่ใน cache ก่อนมี trigger)
update his_visit_cache set hn = hn where visit_date = (now() at time zone 'Asia/Bangkok')::date;
