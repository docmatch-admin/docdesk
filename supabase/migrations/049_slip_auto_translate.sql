-- ใบนัด English แปลอัตโนมัติตอนกด EN แทนช่องภาษาอังกฤษแยก
alter table appointments drop column if exists instructions_en;
alter table appointment_purposes drop column if exists name_en;
alter table appointment_purposes drop column if exists reminder_extra_text_en;
alter table appointment_series drop column if exists title_en;
-- หน้าพิมพ์เปิดเป็นไทยเสมอ ไม่จำภาษาต่อคนไข้แล้ว
alter table patients drop column if exists slip_lang;

-- cache คำแปลต่อข้อความ (hash ของต้นฉบับไทย) พนักงานแก้คำแปลแล้วใช้คำที่แก้ครั้งถัดไป
-- เก็บเฉพาะเหตุผลนัด การปฏิบัติตัว หมายเหตุ ชื่อชุดนัด ไม่มีชื่อ/HN/เบอร์คนไข้
create table if not exists slip_translations (
  source_hash text primary key check (source_hash ~ '^[0-9a-f]{64}$'),
  source text not null check (char_length(source) <= 2000),
  text_en text not null check (char_length(text_en) <= 2000),
  edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- ใช้ผ่าน server (service role) เท่านั้น
alter table slip_translations enable row level security;
