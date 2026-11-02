-- ใช้ข้อมูลจากเว็บแทนรายการที่ซ้ำกัน รายการเดิมมีราคาผิด 2 รายการ: ยาฉีดคุม 3 เดือน และวัคซีนบาดทะยัก
update knowledge_items set active = false
where source = 'manual' and title in (
  'ตรวจคลื่นไฟฟ้าหัวใจ (EKG)',
  'พ่นยาขยายหลอดลม',
  'ยาฉีดคุมกำเนิด',
  'วัคซีน HPV (Gardasil 9)',
  'วัคซีนไข้เลือดออก (Qdenga)',
  'วัคซีนไข้หวัดใหญ่ 4 สายพันธุ์',
  'วัคซีนบาดทะยัก',
  'วัคซีนปอดอักเสบ Prevnar 20 (PCV20)',
  'วัคซีนพิษสุนัขบ้า',
  'วัคซีนไวรัสตับอักเสบบี',
  'ใบรับรองแพทย์',
  'แพ็กเกจตรวจสุขภาพ'
);

-- ข้อเท็จจริงที่ไม่มีบนเว็บจากรายการที่ปิด เก็บเป็นข้อมูลที่แก้ใน DocDesk ได้ ไม่มีราคา embedding สร้างด้วย scripts/embed-knowledge.mjs
insert into knowledge_items (category, title, content)
select 'วัคซีน', 'ชนิดวัคซีนตับอักเสบที่มี', 'มีเฉพาะวัคซีนตับอักเสบบี ไม่มีวัคซีนรวมเอและบี'
where not exists (select 1 from knowledge_items where title = 'ชนิดวัคซีนตับอักเสบที่มี');

insert into knowledge_items (category, title, content)
select 'บริการ', 'แผลเกินความสามารถคลินิก', 'กรณีแผลเกินความสามารถของคลินิกจะส่งต่อโรงพยาบาล'
where not exists (select 1 from knowledge_items where title = 'แผลเกินความสามารถคลินิก');
