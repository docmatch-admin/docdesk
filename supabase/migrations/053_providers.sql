-- ผู้นัด (แพทย์): รายชื่อจากชื่อแพทย์ใน visit ของ iService + ชื่อที่เคยใช้ในนัด
-- ฟอร์มนัดใช้เป็น dropdown ค้นหาได้ (เริ่มที่ "— ไม่ระบุ —") · appointments.provider ยังเก็บเป็นข้อความ (nullable)
-- active: null = อัตโนมัติ (แสดงเมื่อพบภายใน 180 วัน) · true = แสดงเสมอ · false = ซ่อนเสมอ (แอดมินตั้งในหน้าตั้งค่า)
create table if not exists providers (
  name text primary key check (name = regexp_replace(btrim(name), '\s+', ' ', 'g') and length(name) between 1 and 120),
  last_seen_at timestamptz not null default now(),
  active boolean,
  created_at timestamptz not null default now()
);
-- ชื่อซ้ำที่ต่างแค่ตัวพิมพ์ถือเป็นคนเดียวกัน
create unique index if not exists providers_name_ci on providers (lower(name));

alter table providers enable row level security;
drop policy if exists staff_read on providers;
drop policy if exists admin_write on providers;
create policy staff_read on providers for select to authenticated using (is_appointment_staff());
create policy admin_write on providers for all to authenticated using (is_admin()) with check (is_admin());

-- บันทึกชื่อที่พบ (จาก visit หรือจากนัดที่บันทึก): ทำความสะอาด รวมซ้ำ เก็บเวลาที่พบล่าสุด ไม่แตะค่า active ที่แอดมินตั้ง
create or replace function touch_providers(p_names text[], p_seen timestamptz default now())
returns void language sql security definer set search_path = public as $$
  insert into providers (name, last_seen_at)
  select distinct on (lower(n)) n, p_seen
  from (select regexp_replace(btrim(x), '\s+', ' ', 'g') as n from unnest(p_names) as x) s
  where length(n) between 1 and 120
  order by lower(n), n
  on conflict (lower(name)) do update set last_seen_at = greatest(providers.last_seen_at, excluded.last_seen_at);
$$;
revoke all on function touch_providers(text[], timestamptz) from public, anon, authenticated;
grant execute on function touch_providers(text[], timestamptz) to service_role;

-- เติมจากของเดิม: visit ที่เคยดึงมา (90 วันล่าสุด) และนัดเดิม
insert into providers (name, last_seen_at)
select distinct on (lower(n)) n, seen from (
  select regexp_replace(btrim(doctor_name), '\s+', ' ', 'g') as n, max(fetched_at) as seen
  from his_visit_cache where doctor_name is not null group by 1
  union all
  select regexp_replace(btrim(provider), '\s+', ' ', 'g'), max(created_at)
  from appointments where provider is not null group by 1
) s
where length(n) between 1 and 120
order by lower(n), seen desc
on conflict (lower(name)) do update set last_seen_at = greatest(providers.last_seen_at, excluded.last_seen_at);

-- ทำความสะอาดชื่อในนัดเดิม (ช่องว่างซ้อน/หัวท้าย) · ค่าว่างเป็น null
update appointments set provider = nullif(regexp_replace(btrim(provider), '\s+', ' ', 'g'), '')
where provider is not null and provider is distinct from nullif(regexp_replace(btrim(provider), '\s+', ' ', 'g'), '');

-- ชื่อแพทย์ใน visit ที่บันทึกลง cache (ทั้งหน้าเลือกคนไข้และ cron ทุก 5 นาที) → providers ทันที
-- ทำในฐานข้อมูล จึงไม่ขึ้นกับว่า Edge Function deploy เวอร์ชันล่าสุดหรือยัง
create or replace function providers_from_visit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.doctor_name is not null and length(btrim(new.doctor_name)) > 0 then
    perform touch_providers(array[new.doctor_name], coalesce(new.fetched_at, now()));
  end if;
  return new;
end $$;
drop trigger if exists providers_from_visit on his_visit_cache;
create trigger providers_from_visit after insert or update of doctor_name, fetched_at on his_visit_cache
  for each row execute function providers_from_visit();
