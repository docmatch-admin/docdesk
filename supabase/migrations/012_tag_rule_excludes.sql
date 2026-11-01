-- กฎแท็ก: คำยกเว้น ถ้าข้อความมีคำเหล่านี้ห้ามติดแท็ก
alter table tag_rules add column if not exists exclude_keywords text not null default '';

-- เอาคำว่า "บริษัท" เดี่ยวๆ ออก เพราะตรงกับ "บริษัทประกัน" และลูกค้าทั่วไปที่ถามเรื่องสิทธิ
update tag_rules
set keyword = 'ตรวจสุขภาพพนักงาน|พนักงาน|โรงงาน|หมู่คณะ|ใบเสนอราคา|ออกหน่วย|ฝ่ายบุคคล|HR',
    exclude_keywords = 'ประกัน|บัตรทอง|ประกันสังคม'
where kind = 'keyword' and tag = 'B2B บริษัท';

insert into tag_rules (kind, keyword, exclude_keywords, tag)
select 'keyword', 'ตรวจสุขภาพพนักงาน|พนักงาน|โรงงาน|หมู่คณะ|ใบเสนอราคา|ออกหน่วย|ฝ่ายบุคคล|HR', 'ประกัน|บัตรทอง|ประกันสังคม', 'B2B บริษัท'
where not exists (select 1 from tag_rules where kind = 'keyword' and tag = 'B2B บริษัท');
