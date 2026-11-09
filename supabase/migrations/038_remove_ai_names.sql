-- ยกเลิกการที่ AI ตั้งหรือเขียนทับชื่อลูกค้า: ชื่อเหลือ 3 แหล่ง his > staff > platform
-- ชื่อที่ AI ตั้งไว้ คืนเป็นชื่อแพลตฟอร์มเดิม ถ้าผูก HN แล้วใช้ชื่อจาก HIS

update contacts ct set
  display_name = coalesce(
    ct.platform_name,
    case ch.type when 'facebook' then 'ลูกค้า Facebook' when 'instagram' then 'ลูกค้า Instagram' end
  ),
  name_source = case when ct.hn is not null and ct.patient_full_name is not null then 'his' else 'platform' end
from channels ch
where ch.id = ct.channel_id and ct.name_source = 'ai';

alter table contacts drop constraint if exists contacts_name_source_check;
alter table contacts add constraint contacts_name_source_check check (name_source in ('his', 'staff', 'platform'));
