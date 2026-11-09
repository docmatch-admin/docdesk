-- บัญชี LINE/FB เดียวผูกได้หลาย HN (ญาติที่เป็นคนไข้ด้วย / ดูแลหลายคน)
-- แถวผูก = (แชท/บัญชี, HN) ไม่ซ้ำ แต่ละแถวมีบทบาทของบัญชีต่อ HN นั้น
alter table patient_links drop constraint if exists patient_links_pkey;
alter table patient_links add primary key (conversation_id, hn);
alter table patient_links add column if not exists role text not null default 'patient' check (role in ('patient', 'relative'));
create index if not exists patient_links_conv_idx on patient_links (conversation_id, linked_at desc);

-- บทบาทเดิมเก็บที่ contacts.patient_relation (1 บัญชี 1 HN)
update patient_links pl set role = c.patient_relation
from conversations cv join contacts c on c.id = cv.contact_id
where cv.id = pl.conversation_id and c.patient_relation in ('patient', 'relative');

comment on column contacts.hn is 'HN หลักของบัญชี (primary_hn) ใช้ตั้งชื่อแชท: HN ที่บัญชีเป็นคนไข้เอง ไม่มีใช้ HN ล่าสุดที่ผูกเป็นญาติ';
comment on column contacts.patient_relation is 'บทบาทของบัญชีต่อ HN หลัก (relative = ไม่มี HN ที่เป็นคนไข้เอง ชื่อแชทต่อท้าย (ญาติ))';
