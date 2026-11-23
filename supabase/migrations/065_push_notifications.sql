-- แจ้งเตือน push (iPhone ที่ติดตั้งลงหน้าจอโฮม / Android / คอม)
-- push_subscriptions มีตั้งแต่ 023 (endpoint, staff_id, p256dh, auth, created_at) หนึ่งคนมีได้หลายเครื่อง (endpoint ละแถว)
alter table push_subscriptions add column if not exists user_agent text;
alter table push_subscriptions add column if not exists last_seen_at timestamptz not null default now();
create index if not exists push_subscriptions_staff_idx on push_subscriptions (staff_id);

-- แชทที่เจ้าหน้าที่เปิดดูอยู่ (หน้าจอเปิดอยู่) — ไม่ส่ง push ของแชทนั้นซ้ำให้คนที่กำลังดู
-- อัปเดตทุก ~30 วิ จากหน้าแชท ถือว่าหมดอายุเมื่อเกิน 75 วิ
create table if not exists staff_presence (
  staff_id uuid primary key references staff(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  seen_at timestamptz not null default now()
);
alter table staff_presence enable row level security;

-- กันแจ้งเตือนรัวเมื่อลูกค้าส่งหลายข้อความติดกัน (แจ้งแชทเดียวกันไม่เกินทุก 60 วิ)
alter table conversations add column if not exists last_push_at timestamptz;
