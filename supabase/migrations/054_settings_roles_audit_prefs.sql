-- ตั้งค่า: เปิดบางส่วนให้ agent · ประวัติการแก้ตั้งค่า · ตั้งค่าส่วนตัวต่อผู้ใช้ · เปลี่ยนชื่อแท็กอย่างปลอดภัย
-- สิทธิ์บังคับที่ฐานข้อมูล (RLS) ไม่ใช่แค่ซ่อนในหน้าเว็บ

-- admin หรือ agent ที่ใช้งานได้ (ไม่รวมห้องยา) = แก้ส่วนที่เปิดให้ agent ได้
create or replace function is_settings_editor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid() and active and not must_change_password and role in ('admin', 'agent'));
$$;

-- ---------------------------------------------------------------------------
-- 1) ส่วนที่ agent แก้ได้: แท็ก กฎติดแท็ก เหตุผลนัด วันหยุดพิเศษ template ชุดนัด รายชื่อผู้นัด
--    (เวลาเปิดคลินิก clinic_hours ยังแก้ได้เฉพาะ admin)
do $$
declare t text;
begin
  foreach t in array array['tags', 'tag_rules', 'appointment_purposes', 'clinic_closures', 'appointment_series_templates', 'providers'] loop
    execute format('drop policy if exists admin_write on %I', t);
    execute format('drop policy if exists editor_write on %I', t);
    execute format('create policy editor_write on %I for all to authenticated using (is_settings_editor()) with check (is_settings_editor())', t);
  end loop;
end $$;

-- 2) ตาราง settings: admin อ่าน/แก้ทั้งหมด · agent อ่านได้เฉพาะคีย์ที่ต้องใช้/แสดงแบบอ่านอย่างเดียว
--    (โมเดล AI บุคลิก แชทลับ เกณฑ์คะแนน การเก็บรูป อ่านไม่ได้)
drop policy if exists staff_read on settings;
drop policy if exists admin_read on settings;
drop policy if exists agent_read on settings;
create policy admin_read on settings for select to authenticated using (is_admin());
create policy agent_read on settings for select to authenticated using (
  is_staff() and key in ('ai_mode', 'business_hours', 'appointment_settings', 'booking_templates', 'auto_close_hours')
);

-- ---------------------------------------------------------------------------
-- 3) ประวัติการแก้ตั้งค่า: บันทึกด้วย trigger ทุกการแก้จากหน้าเว็บ (ทั้ง admin และ agent)
--    การแก้ผ่าน server (service role) ที่เป็นการตั้งค่าของผู้ใช้ เช่น โมเดล AI บันทึกเองพร้อมชื่อผู้แก้
create table if not exists settings_audit (
  id bigserial primary key,
  actor_id uuid references staff(id) on delete set null,
  actor_name text,
  section text not null,
  table_name text not null,
  record_key text,
  action text not null check (action in ('insert', 'update', 'delete')),
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);
create index if not exists settings_audit_created_idx on settings_audit (created_at desc);
alter table settings_audit enable row level security;
revoke all on settings_audit from anon;
drop policy if exists admin_read on settings_audit;
create policy admin_read on settings_audit for select to authenticated using (is_admin());

create or replace function audit_setting_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_key text;
  v_section text;
begin
  -- server (service role) ไม่มีผู้ใช้: งานระบบ เช่น ซิงก์ราคา ไม่ใช่การแก้ตั้งค่าของคน
  if auth.uid() is null then return null; end if;
  if tg_op = 'UPDATE' and v_old = v_new then return null; end if;
  v_key := coalesce(v_row->>'key', v_row->>'name', v_row->>'closed_on', v_row->>'keyword', v_row->>'id');
  v_section := case tg_table_name
    when 'settings' then case v_row->>'key'
      when 'appointment_settings' then 'นัดหมาย' when 'booking_templates' then 'นัดหมาย'
      when 'business_hours' then 'แชทและแท็ก' when 'auto_close_hours' then 'แชทและแท็ก'
      when 'sensitive_keywords' then 'แชทและแท็ก' when 'sensitive_media_retention_days' then 'แชทและแท็ก'
      when 'score_rules' then 'ทีมและระบบ' when 'media_retention_days' then 'ทีมและระบบ'
      else 'AI' end
    when 'channels' then 'AI'
    when 'tags' then 'แชทและแท็ก' when 'tag_rules' then 'แชทและแท็ก'
    else 'นัดหมาย' end;
  if tg_table_name = 'clinic_hours' then v_key := coalesce(v_row->>'weekday', '') || ':' || coalesce(v_row->>'slot_id', ''); end if;
  insert into settings_audit (actor_id, actor_name, section, table_name, record_key, action, old_value, new_value)
  values (auth.uid(), (select display_name from staff where id = auth.uid()), v_section, tg_table_name, v_key, lower(tg_op), v_old, v_new);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['settings', 'channels', 'tags', 'tag_rules', 'appointment_purposes', 'clinic_hours', 'clinic_closures', 'appointment_series_templates', 'providers'] loop
    execute format('drop trigger if exists audit_settings on %I', t);
    execute format('create trigger audit_settings after insert or update or delete on %I for each row execute function audit_setting_change()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4) ตั้งค่าส่วนตัวต่อผู้ใช้ (sync ทุกเครื่องของคนนั้น): ธีม เสียงเตือน แจ้งเตือน ย่อเมนู ขนาดตัวอักษร
create table if not exists user_preferences (
  user_id uuid primary key references staff(id) on delete cascade,
  theme text not null default 'system' check (theme in ('system', 'light', 'dark')),
  sound_muted boolean not null default false,
  push_enabled boolean not null default true,
  nav_collapsed boolean not null default false,
  font_size text not null default 'normal' check (font_size in ('normal', 'large')),
  updated_at timestamptz not null default now()
);
alter table user_preferences enable row level security;
revoke all on user_preferences from anon;
grant select, insert, update on user_preferences to authenticated;
drop policy if exists own_prefs on user_preferences;
create policy own_prefs on user_preferences for all to authenticated
  using (user_id = auth.uid() and exists (select 1 from staff where id = auth.uid() and active))
  with check (user_id = auth.uid() and exists (select 1 from staff where id = auth.uid() and active));
do $$ begin
  alter publication supabase_realtime add table user_preferences;
exception when others then null; end $$;

-- ---------------------------------------------------------------------------
-- 5) เปลี่ยนชื่อแท็ก: แชทเก็บแท็กเป็นชื่อ จึงเปลี่ยนทุกที่พร้อมกันในธุรกรรมเดียว
--    แท็กที่โค้ดใช้ตามชื่อ (นัดแล้ว ตามต่อ รอนัด STD) เปลี่ยนไม่ได้
create or replace function rename_tag(p_id uuid, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_old text;
  v_new text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if not is_settings_editor() then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(v_new) not between 1 and 40 then raise exception 'ชื่อแท็กต้องยาว 1–40 ตัวอักษร'; end if;
  select name into v_old from tags where id = p_id for update;
  if v_old is null then raise exception 'ไม่พบแท็ก'; end if;
  if v_old = v_new then return v_new; end if;
  if v_old in ('นัดแล้ว', 'ตามต่อ', 'รอนัด', 'STD') then raise exception 'แท็กนี้ระบบใช้ตามชื่อ เปลี่ยนชื่อไม่ได้'; end if;
  if exists (select 1 from tags where lower(name) = lower(v_new) and id <> p_id) then raise exception 'มีแท็กชื่อนี้แล้ว' using errcode = '23505'; end if;
  update tags set name = v_new where id = p_id;
  update conversations set tags = array_replace(tags, v_old, v_new) where v_old = any(tags);
  update suggestions set suggested_tags = array_replace(suggested_tags, v_old, v_new) where v_old = any(suggested_tags);
  update tag_rules set tag = v_new where tag = v_old;
  update tag_events set tag = v_new where tag = v_old;
  return v_new;
end $$;
revoke all on function rename_tag(uuid, text) from public, anon;
grant execute on function rename_tag(uuid, text) to authenticated;
