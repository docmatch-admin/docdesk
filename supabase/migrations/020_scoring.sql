-- คะแนนเจ้าหน้าที่: ความเร็วการตอบ และคุณภาพ
create table if not exists response_events (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  inbound_message_id uuid not null references messages(id) on delete cascade,
  first_inbound_at timestamptz not null,
  replied_by uuid not null references staff(id) on delete cascade,
  replied_at timestamptz not null,
  response_seconds int not null,
  business_seconds int not null,
  points numeric(6,2) not null,
  reply_length int not null,
  created_at timestamptz not null default now(),
  -- ชุดข้อความหนึ่งมีผู้ตอบแรกคนเดียว ส่งพร้อมกันสองคนจะไม่ได้คะแนนซ้ำ
  unique (inbound_message_id)
);
create index if not exists response_events_staff_idx on response_events (replied_by, replied_at);
create index if not exists response_events_time_idx on response_events (replied_at);

create table if not exists score_events (
  id bigserial primary key,
  staff_id uuid not null references staff(id) on delete cascade,
  kind text not null check (kind in ('star', 'close')),
  points numeric(6,2) not null,
  conversation_id uuid references conversations(id) on delete cascade,
  message_id uuid references messages(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists score_events_staff_idx on score_events (staff_id, created_at);
create index if not exists score_events_conv_idx on score_events (conversation_id, kind, created_at desc);
-- ข้อความหนึ่งได้คะแนนดาวครั้งเดียว
create unique index if not exists score_events_star_once on score_events (message_id) where kind = 'star';

alter table response_events enable row level security;
alter table score_events enable row level security;
-- เจ้าหน้าที่เห็นของตัวเอง admin เห็นทุกคน อันดับทีมส่งผ่าน API เขียนผ่าน service role เท่านั้น
drop policy if exists own_or_admin on response_events;
create policy own_or_admin on response_events for select to authenticated using (is_staff() and (replied_by = auth.uid() or is_admin()));
drop policy if exists own_or_admin on score_events;
create policy own_or_admin on score_events for select to authenticated using (is_staff() and (staff_id = auth.uid() or is_admin()));

insert into settings (key, value) values ('score_rules', '{
  "speed": [{"maxSeconds": 120, "points": 3}, {"maxSeconds": 300, "points": 2}, {"maxSeconds": 900, "points": 1}],
  "shortChars": 15,
  "starPoints": 2,
  "closePoints": 1
}') on conflict (key) do nothing;
