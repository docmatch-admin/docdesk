-- ข้อความนัดตามภาษาของลูกค้า: เก็บคำแปล แปลครั้งเดียวต่อภาษา (ชุดวลี + template) และต่อข้อความที่เจ้าหน้าที่พิมพ์
-- ใช้จากฝั่งเซิร์ฟเวอร์ (service role) เท่านั้น
create table if not exists appointment_translations (
  lang text not null,
  source_hash text not null,
  source text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (lang, source_hash)
);
alter table appointment_translations enable row level security;
