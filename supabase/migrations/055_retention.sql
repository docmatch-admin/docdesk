-- นโยบายเก็บข้อมูล: งานที่เสร็จแล้ว (+คอมเมนต์ในงาน) และนัดที่ยกเลิก ซ่อนทันที ลบถาวรเมื่อพ้นระยะ
-- ก่อนลบเก็บตัวเลขสรุปรายเดือนใน retention_stats (รายงานย้อนหลังยังได้ตัวเลขเดิม)
-- การลบทำในฟังก์ชันเดียวต่อชุด (≤ 500 แถว): ตรวจเงื่อนไขซ้ำ + บันทึกสถิติ + ลบ ในธุรกรรมเดียว

-- ตัวเลขสรุปของแถวที่ลบไปแล้ว (เดือนตามเวลาไทย)
create table if not exists retention_stats (
  month date not null,
  metric text not null check (metric in ('tasks_done', 'appointments_cancelled')),
  dim text not null check (dim in ('assignee', 'cancel_reason', 'purpose')),
  key text not null,
  count integer not null default 0 check (count >= 0),
  primary key (month, metric, dim, key)
);

-- log แต่ละรอบ (admin ดูได้ในหน้าตั้งค่า → ทีมและระบบ)
create table if not exists retention_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  tasks_deleted integer not null default 0,
  notes_deleted integer not null default 0,
  appointments_deleted integer not null default 0,
  events_deleted integer not null default 0,
  series_deleted integer not null default 0,
  batches integer not null default 0,
  error text
);
create index if not exists retention_runs_started_idx on retention_runs (started_at desc);

alter table retention_stats enable row level security;
alter table retention_runs enable row level security;
revoke all on retention_stats, retention_runs from anon, authenticated;
grant select on retention_stats, retention_runs to authenticated;
drop policy if exists admin_read on retention_stats;
drop policy if exists admin_read on retention_runs;
create policy admin_read on retention_stats for select to authenticated using (is_admin());
create policy admin_read on retention_runs for select to authenticated using (is_admin());

-- ค่าเริ่มต้นระยะเก็บ (แก้ได้ในหน้าตั้งค่า ต่ำสุด 7 วัน)
insert into settings (key, value) values ('retention_task_days', '30'), ('retention_cancelled_appointment_days', '90')
on conflict (key) do nothing;

create or replace function retention_days(p_key text, p_default integer) returns integer
language sql stable security definer set search_path = public as $$
  select greatest(7, coalesce((select (value #>> '{}')::integer from settings where key = p_key), p_default));
$$;

-- ---------------------------------------------------------------------------
-- งานที่เสร็จแล้ว: ลบเมื่อแชทปิดอยู่ และปิดล่าสุดครบระยะ (งานค้าง/แชทที่เปิดอยู่ไม่แตะ) คอมเมนต์ในงานลบตาม (FK cascade)
create or replace function retention_delete_tasks(p_limit integer default 500) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_days integer := retention_days('retention_task_days', 30);
  v_tasks integer;
  v_notes integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'batch ต้องอยู่ระหว่าง 1–500 แถว'; end if;
  create temp table _victims on commit drop as
    select t.id, t.assignee_id, t.done_at from chat_tasks t join conversations c on c.id = t.conversation_id
    where t.done and c.status = 'closed' and c.closed_at is not null
      and c.closed_at <= now() - make_interval(days => v_days)
    order by c.closed_at limit p_limit;
  insert into retention_stats (month, metric, dim, key, count)
    select date_trunc('month', done_at at time zone 'Asia/Bangkok')::date, 'tasks_done', 'assignee', coalesce(assignee_id::text, 'none'), count(*)
    from _victims group by 1, 4
  on conflict (month, metric, dim, key) do update set count = retention_stats.count + excluded.count;
  select count(*) into v_notes from chat_notes where task_id in (select id from _victims);
  delete from chat_tasks where id in (select id from _victims);
  get diagnostics v_tasks = row_count;
  return jsonb_build_object('tasks', v_tasks, 'notes', v_notes);
end $$;

-- นัดที่ยกเลิก: ลบเมื่อเลยวันนัดไปครบระยะ (เฉพาะ status = cancelled) log ของนัดลบตาม (FK cascade)
-- ชุดนัด: ถ้าไม่เหลือนัดในชุดเลย ลบชุดด้วย
create or replace function retention_delete_appointments(p_limit integer default 500) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_days integer := retention_days('retention_cancelled_appointment_days', 90);
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
  v_appts integer;
  v_events integer;
  v_series integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'batch ต้องอยู่ระหว่าง 1–500 แถว'; end if;
  create temp table _victims on commit drop as
    select id, appoint_date, cancel_reason_code, purpose_text, series_id from appointments
    where status = 'cancelled' and appoint_date <= v_today - v_days
    order by appoint_date limit p_limit;
  insert into retention_stats (month, metric, dim, key, count)
    select date_trunc('month', appoint_date)::date, 'appointments_cancelled', 'cancel_reason', coalesce(cancel_reason_code, 'none'), count(*)
    from _victims group by 1, 4
  on conflict (month, metric, dim, key) do update set count = retention_stats.count + excluded.count;
  insert into retention_stats (month, metric, dim, key, count)
    select date_trunc('month', appoint_date)::date, 'appointments_cancelled', 'purpose', coalesce(nullif(btrim(purpose_text), ''), 'none'), count(*)
    from _victims group by 1, 4
  on conflict (month, metric, dim, key) do update set count = retention_stats.count + excluded.count;
  select count(*) into v_events from appointment_events where appointment_id in (select id from _victims);
  delete from appointments where id in (select id from _victims);
  get diagnostics v_appts = row_count;
  delete from appointment_series s
    where s.id in (select series_id from _victims where series_id is not null)
      and not exists (select 1 from appointments a where a.series_id = s.id);
  get diagnostics v_series = row_count;
  return jsonb_build_object('appointments', v_appts, 'events', v_events, 'series', v_series);
end $$;

revoke all on function retention_delete_tasks(integer) from public, anon, authenticated;
revoke all on function retention_delete_appointments(integer) from public, anon, authenticated;
grant execute on function retention_delete_tasks(integer) to service_role;
grant execute on function retention_delete_appointments(integer) to service_role;

-- ---------------------------------------------------------------------------
-- FK ที่ชี้ไปยังงาน/คอมเมนต์/นัด/ชุดนัด แบบห้ามลบ (NO ACTION/RESTRICT) เปลี่ยนเป็น ON DELETE SET NULL ไม่ให้การลบล้ม
-- (log ของนัด appointment_events/ผู้รับ/การจับคู่ HN เป็น cascade อยู่แล้ว ลบตามนัด)
do $$
declare r record;
begin
  for r in
    select con.conname, cl.relname as child, att.attname as col, parent.relname as parent_table
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace ns on ns.oid = cl.relnamespace and ns.nspname = 'public'
    join pg_class parent on parent.oid = con.confrelid
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'f' and con.confdeltype in ('a', 'r') and array_length(con.conkey, 1) = 1
      and parent.relname in ('chat_tasks', 'chat_notes', 'appointments', 'appointment_series')
  loop
    execute format('alter table %I alter column %I drop not null', r.child, r.col);
    execute format('alter table %I drop constraint %I', r.child, r.conname);
    execute format('alter table %I add constraint %I foreign key (%I) references %I(id) on delete set null',
      r.child, r.conname, r.col, r.parent_table);
  end loop;
end $$;

-- ดัชนีสำหรับหาแถวที่หมดอายุ
create index if not exists chat_tasks_done_idx on chat_tasks (conversation_id) where done;
create index if not exists appointments_cancelled_date_idx on appointments (appoint_date) where status = 'cancelled';

-- ---------------------------------------------------------------------------
-- pg_cron วันละครั้ง 03:00 เวลาไทย (20:00 UTC) เรียก /api/cron/retention ด้วยค่าลับใน Vault (docdesk_cron_secret)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net')
     and exists (select 1 from vault.secrets where name = 'docdesk_cron_secret') then
    perform cron.unschedule('docdesk-retention') where exists (select 1 from cron.job where jobname = 'docdesk-retention');
    perform cron.schedule('docdesk-retention', '0 20 * * *', $job$
      select net.http_post(
        url := 'https://docdesk-tau.vercel.app/api/cron/retention',
        headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'docdesk_cron_secret')),
        timeout_milliseconds := 55000
      );
    $job$);
  else
    raise notice 'ข้าม pg_cron: ยังไม่มี pg_cron/pg_net หรือค่าลับใน Vault (ตั้งด้วย supabase/manual/036_appointment_cron.sql ก่อน)';
  end if;
end $$;
