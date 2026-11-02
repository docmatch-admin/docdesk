-- นำเข้าประวัติแชท LINE: แยกจากข้อความจริง ไม่กระทบคิวรอตอบ เสียงเตือน หรือคะแนน
create table if not exists import_batches (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'line_import',
  filename text,
  created_by uuid references staff(id) on delete set null,
  rooms integer not null default 0,
  messages_imported integer not null default 0,
  examples_imported integer not null default 0,
  hidden_at timestamptz,
  created_at timestamptz not null default now()
);
alter table import_batches enable row level security;
drop policy if exists admin_read on import_batches;
create policy admin_read on import_batches for select to authenticated using (is_admin());

-- unique ธรรมดา เพราะ upsert ใช้ partial index ไม่ได้ และ null หลายแถวไม่ชนกัน
alter table messages add column if not exists imported boolean not null default false;
alter table messages add column if not exists import_hash text unique;
alter table messages add column if not exists import_batch_id uuid references import_batches(id) on delete set null;

alter table reply_examples add column if not exists source text not null default 'staff';
alter table reply_examples add column if not exists import_hash text unique;
alter table reply_examples add column if not exists import_batch_id uuid references import_batches(id) on delete set null;
create index if not exists reply_examples_batch_idx on reply_examples (import_batch_id) where import_batch_id is not null;

create or replace function refresh_conversation_queue() returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_conversation uuid := coalesce(new.conversation_id, old.conversation_id);
  v_last_direction text;
  v_last_inbound timestamptz;
  v_last_outbound timestamptz;
  v_closed_at timestamptz;
begin
  -- ข้อความนำเข้าเป็นประวัติเก่า ไม่เปลี่ยนสถานะคิว
  if (tg_op = 'INSERT' and new.imported) or (tg_op = 'DELETE' and old.imported) then
    return null;
  end if;

  select direction into v_last_direction from messages
    where conversation_id = v_conversation and not imported order by created_at desc, id desc limit 1;
  select max(created_at) filter (where direction = 'in'), max(created_at) filter (where direction = 'out')
    into v_last_inbound, v_last_outbound
    from messages where conversation_id = v_conversation and not imported;
  select closed_at into v_closed_at from conversations where id = v_conversation;

  update conversations set
    last_direction = v_last_direction,
    last_inbound_at = v_last_inbound,
    -- ข้อความก่อนกดเสร็จแล้วไม่นับเป็นเวลารอ
    waiting_since = (
      select min(created_at) from messages
      where conversation_id = v_conversation and direction = 'in' and not imported
        and created_at > greatest(coalesce(v_last_outbound, '-infinity'), coalesce(v_closed_at, '-infinity'))
    )
  where id = v_conversation;
  return null;
end;
$$;
