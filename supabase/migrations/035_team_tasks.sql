-- งานของทีมและคอมเมนต์ภายในของแต่ละแชท: เจ้าหน้าที่เห็นเท่านั้น ไม่ส่งถึงลูกค้าทุกช่องทาง
-- เขียนผ่าน API ด้วย service role เท่านั้น หน้าเว็บอ่านได้ตามสิทธิ์อ่านแชท (รวมกติกาแชทลับ)

create table if not exists chat_tasks (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  text text not null check (char_length(btrim(text)) between 1 and 500),
  assignee_id uuid references staff(id) on delete set null,
  done boolean not null default false,
  done_by uuid references staff(id) on delete set null,
  done_at timestamptz,
  created_by uuid references staff(id) on delete set null,
  created_at timestamptz not null default now(),
  -- ให้คอมเมนต์ของงานอ้างอิงคู่ (งาน, แชท) ได้ คอมเมนต์จึงอยู่คนละแชทกับงานไม่ได้
  unique (id, conversation_id),
  check ((done and done_at is not null) or (not done and done_by is null and done_at is null))
);
create index if not exists chat_tasks_conversation_idx on chat_tasks (conversation_id, created_at);

create table if not exists chat_notes (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  task_id uuid,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  author_id uuid references staff(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (task_id, conversation_id) references chat_tasks (id, conversation_id) on delete cascade
);
create index if not exists chat_notes_conversation_idx on chat_notes (conversation_id, created_at);
create index if not exists chat_notes_task_idx on chat_notes (task_id, created_at) where task_id is not null;

-- นับงานค้างไว้ที่แชท ใช้แสดงป้าย "งานค้าง N" กันกดเสร็จแล้ว และกันย้ายไปเสร็จแล้วอัตโนมัติ
alter table conversations add column if not exists open_tasks integer not null default 0;

create or replace function refresh_open_tasks() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation uuid := coalesce(new.conversation_id, old.conversation_id);
begin
  update conversations
    set open_tasks = (select count(*) from chat_tasks where conversation_id = v_conversation and not done)
    where id = v_conversation;
  return null;
end;
$$;

drop trigger if exists chat_tasks_refresh_open on chat_tasks;
create trigger chat_tasks_refresh_open
  after insert or update of done or delete on chat_tasks
  for each row execute function refresh_open_tasks();

-- RLS: อ่านได้เฉพาะเจ้าหน้าที่ที่อ่านแชทนั้นได้ (แชทลับต้องมีสิทธิ์) ไม่มี policy สำหรับเขียน
alter table chat_tasks enable row level security;
alter table chat_notes enable row level security;
revoke all on chat_tasks from anon, authenticated;
revoke all on chat_notes from anon, authenticated;
grant select on chat_tasks to authenticated;
grant select on chat_notes to authenticated;

drop policy if exists staff_read on chat_tasks;
create policy staff_read on chat_tasks for select to authenticated using (can_read_conversation(conversation_id));
drop policy if exists staff_read on chat_notes;
create policy staff_read on chat_notes for select to authenticated using (can_read_conversation(conversation_id));

-- เจ้าหน้าที่คนอื่นเห็นงานและคอมเมนต์ทันที realtime ใช้ RLS เดียวกัน
do $$
begin
  alter publication supabase_realtime add table chat_tasks, chat_notes;
exception when duplicate_object then null;
end $$;
