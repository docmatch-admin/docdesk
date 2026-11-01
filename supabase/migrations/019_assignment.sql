-- ผู้ดูแลแชท: conversations.assigned_to มีอยู่แล้ว เพิ่มประวัติการเปลี่ยน
create table if not exists assignment_log (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  from_staff uuid references staff(id) on delete set null,
  to_staff uuid references staff(id) on delete set null,
  by_staff uuid references staff(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists assignment_log_conv_idx on assignment_log (conversation_id, created_at desc);
create index if not exists conversations_assigned_idx on conversations (assigned_to) where assigned_to is not null;

alter table assignment_log enable row level security;
drop policy if exists staff_read on assignment_log;
create policy staff_read on assignment_log for select to authenticated using (is_staff());

-- เปลี่ยนผู้ดูแลแบบ atomic และบันทึกเฉพาะเมื่อเปลี่ยนจริง สิทธิ์ตรวจที่ API
create or replace function set_assignee(p_conversation uuid, p_to uuid, p_by uuid)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_from uuid;
begin
  select assigned_to into v_from from conversations where id = p_conversation for update;
  if not found then
    raise exception 'conversation not found';
  end if;
  if v_from is distinct from p_to then
    update conversations set assigned_to = p_to where id = p_conversation;
    insert into assignment_log (conversation_id, from_staff, to_staff, by_staff) values (p_conversation, v_from, p_to, p_by);
  end if;
  return p_to;
end;
$$;

-- เจ้าหน้าที่ตอบแชทที่ยังไม่มีผู้ดูแล: เป็นผู้ดูแลอัตโนมัติ ถ้ามีคนรับไปก่อนแล้วไม่แตะ
create or replace function assign_if_unassigned(p_conversation uuid, p_to uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  update conversations set assigned_to = p_to where id = p_conversation and assigned_to is null;
  if found then
    insert into assignment_log (conversation_id, from_staff, to_staff, by_staff) values (p_conversation, null, p_to, p_to);
  end if;
end;
$$;

revoke all on function set_assignee(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function assign_if_unassigned(uuid, uuid) from public, anon, authenticated;
grant execute on function set_assignee(uuid, uuid, uuid) to service_role;
grant execute on function assign_if_unassigned(uuid, uuid) to service_role;
