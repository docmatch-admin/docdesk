-- ล็อกอินด้วยชื่อผู้ใช้ บังคับเปลี่ยนรหัสชั่วคราว และเตรียมจับคู่พนักงาน HR
alter table staff add column if not exists username text unique
  check (username ~ '^[a-z0-9._]{3,20}$');
alter table staff add column if not exists must_change_password boolean not null default false;
alter table staff add column if not exists hr_employee_id uuid unique;
alter table staff add column if not exists full_name text;
alter table staff add column if not exists position text;
alter table staff add column if not exists active boolean not null default true;

-- ยังไม่เปลี่ยนรหัสชั่วคราว = ยังไม่มีสิทธิ์เจ้าหน้าที่ กันการเรียกฐานข้อมูลตรงด้วย
create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid() and active and not must_change_password);
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid() and active and not must_change_password and role = 'admin');
$$;

-- is_staff() เป็น false ระหว่างรอเปลี่ยนรหัส จึงต้องอ่านแถวของตัวเองได้เพื่อรู้สถานะ
drop policy if exists own_read on staff;
create policy own_read on staff for select to authenticated using (id = auth.uid());

-- รีเซ็ตรหัสหรือปิดบัญชีแล้ว session เดิมต้องใช้ต่อไม่ได้ ไม่งั้นคนที่ถือ session เก่าตั้งรหัสใหม่เองได้
create or replace function revoke_staff_sessions(p_user uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from auth.sessions where user_id = p_user;
$$;

revoke all on function revoke_staff_sessions(uuid) from public, anon, authenticated;
grant execute on function revoke_staff_sessions(uuid) to service_role;
