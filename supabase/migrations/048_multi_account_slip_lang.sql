-- 1) HN เดียวผูก LINE ได้หลายบัญชี (คนไข้ + ญาติ): ป้ายต่อบัญชี
alter table contacts add column if not exists patient_relation text check (patient_relation in ('patient', 'relative'));

-- บัญชีเพิ่มเติมที่รับข้อความของนัดที่ไม่มี HN (มี HN ใช้ patient_links)
create table if not exists appointment_recipients (
  appointment_id uuid not null references appointments(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (appointment_id, conversation_id)
);
create index if not exists appointment_recipients_conv_idx on appointment_recipients (conversation_id);
alter table appointment_recipients enable row level security;
drop policy if exists appointment_recipients_staff_read on appointment_recipients;
create policy appointment_recipients_staff_read on appointment_recipients for select to authenticated using (is_appointment_staff());

-- บัญชีที่ผูก HN อยู่แล้วตอนนี้: บัญชีแรกของแต่ละ HN = คนไข้ บัญชีถัดไป = ญาติ
with ranked as (
  select c.id, row_number() over (partition by pl.hn order by pl.linked_at) as n
  from patient_links pl
  join conversations cv on cv.id = pl.conversation_id
  join contacts c on c.id = cv.contact_id
)
update contacts set patient_relation = case when ranked.n = 1 then 'patient' else 'relative' end
from ranked where contacts.id = ranked.id and contacts.patient_relation is null;

-- 2) ใบนัดเลือกภาษา: ภาษาที่เลือกล่าสุดต่อคนไข้
alter table patients add column if not exists slip_lang text check (slip_lang in ('th', 'en'));

-- 3) ข้อความอังกฤษของ preset / นัด / ชุดนัด
alter table appointment_purposes add column if not exists name_en text check (char_length(name_en) <= 100);
alter table appointment_purposes add column if not exists reminder_extra_text_en text check (char_length(reminder_extra_text_en) <= 500);
alter table appointments add column if not exists instructions_en text check (char_length(instructions_en) <= 1000);
alter table appointment_series add column if not exists title_en text check (char_length(title_en) <= 200);

update appointment_purposes p set
  name_en = coalesce(p.name_en, s.name_en),
  reminder_extra_text_en = coalesce(p.reminder_extra_text_en, s.extra_en)
from (values
  ('ฟังผลแล็บ', 'Lab results', null),
  ('เจาะเลือด', 'Blood test', 'Fast 8–12 hrs (plain water OK)'),
  ('ติดตามอาการ', 'Follow-up', null),
  ('โรคเรื้อรัง-รับยาต่อเนื่อง', 'Chronic care / medication refill', 'Please bring your current medicines'),
  ('ทำแผล', 'Wound dressing', null),
  ('ตัดไหม', 'Stitch removal', null),
  ('ฉีดยา-วัคซีน', 'Injection / vaccine', null),
  ('อื่นๆ', 'Other', null)
) as s(name, name_en, extra_en)
where lower(btrim(p.name)) = lower(btrim(s.name));
