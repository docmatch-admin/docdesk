-- ราคาตรวจแล็บ: ราคาขายให้เจ้าหน้าที่ทุกคนอ่านได้ ต้นทุนอ่านได้ผ่าน API ของ admin เท่านั้น
create table if not exists lab_items (
  code text primary key,
  name_en text not null,
  name_th text not null default '',
  tube text,
  cost numeric(10,2),
  price numeric(10,2) check (price is null or price >= 0),
  category text not null default 'อื่นๆ',
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists lab_packages (
  code text primary key,
  name text not null,
  price numeric(10,2) not null check (price >= 0),
  cost numeric(10,2),
  includes text[] not null default '{}',
  compare_item_codes text[] not null default '{}',
  items_without_single_price text[] not null default '{}',
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table lab_items enable row level security;
alter table lab_packages enable row level security;

drop policy if exists staff_read on lab_items;
create policy staff_read on lab_items for select to authenticated using (is_staff());
drop policy if exists staff_read on lab_packages;
create policy staff_read on lab_packages for select to authenticated using (is_staff());

-- RLS กันรายคอลัมน์ไม่ได้ จึงให้สิทธิ์ทีละคอลัมน์โดยไม่รวม cost: แม้เรียกฐานข้อมูลตรงก็อ่านต้นทุนไม่ได้
-- admin อ่านต้นทุนและแก้ราคาผ่าน /api/lab-prices ซึ่งใช้ service role หลังตรวจสิทธิ์แล้ว
revoke all on lab_items from anon, authenticated;
revoke all on lab_packages from anon, authenticated;
grant select (code, name_en, name_th, tube, price, category, active) on lab_items to authenticated;
grant select (code, name, price, includes, compare_item_codes, items_without_single_price, active) on lab_packages to authenticated;

insert into settings (key, value) values ('lab_b2b_rules', '{
  "tiers": [{"minStaff": 10, "percent": 5}, {"minStaff": 30, "percent": 10}, {"minStaff": 100, "percent": 15}],
  "minProfitPerPerson": 150
}') on conflict (key) do nothing;

-- ใช้ตารางใหม่แทนข้อมูลเดิม เก็บ EKG ไว้
update knowledge_items set active = false where title = 'แพ็กเกจตรวจสุขภาพ';

-- ราคาตรวจแล็บ HappiWell (จากไฟล์ราคาแล็บ 28 ต.ค. 2569)
-- cost = ต้นทุนส่งแล็บนอก ห้ามส่งให้ AI หรือลูกค้า

insert into lab_items (code, name_en, name_th, tube, cost, price, category) values
  ('CBC','CBC','ความสมบูรณ์ของเม็ดเลือด','ม่วง',33,100,'เลือด'),
  ('ABO','Blood group ABO','หมู่เลือด ABO','ม่วง',25,100,'เลือด'),
  ('RH','Blood group Rh','หมู่เลือด Rh','ม่วง',25,100,'เลือด'),
  ('RF','Rheumatoid factor','รูมาตอยด์','แดง',150,300,'อื่นๆ'),
  ('URIC','Uric acid','เก๊าท์','แดง',25,200,'ไต/เก๊าท์'),
  ('THAL','Thalassemia','ธาลัสซีเมีย','ม่วง',400,600,'เลือด'),
  ('HBTYPE_SCR','Hb Typing','คัดกรองธาลัสซีเมีย','ม่วง',200,500,'เลือด'),
  ('HBSAB','HBsAb','ภูมิคุ้มกันไวรัสตับอักเสบบี','แดง',60,150,'ติดเชื้อ'),
  ('HBSAG','HBsAg','เชื้อไวรัสตับอักเสบบี','แดง',50,150,'ติดเชื้อ'),
  ('VDRL','VDRL','ซิฟิลิส','แดง',60,300,'ติดเชื้อ'),
  ('TPHA_SCR','TPHA screening','ซิฟิลิส คอนเฟิร์ม','แดง',180,300,'ติดเชื้อ'),
  ('TPHA_TITER','TPHA ตัวเลข','ซิฟิลิส คอนเฟิร์ม (ตัวเลข)','แดง',300,700,'ติดเชื้อ'),
  ('HIV','Anti-HIV screening','HIV','แดง',160,300,'ติดเชื้อ'),
  ('CD4','CD4','CD4','ม่วง',1500,2000,'ติดเชื้อ'),
  ('LIPID','Lipid profile','ไขมันในเลือด (Cholesterol, TG, HDL, LDL)','แดง',80,200,'ไขมัน/น้ำตาล'),
  ('FBS','FBS','น้ำตาลในเลือด','เทา',25,100,'ไขมัน/น้ำตาล'),
  ('HBA1C','HbA1c','น้ำตาลสะสม','ม่วง',140,250,'ไขมัน/น้ำตาล'),
  ('CR','Creatinine','การทำงานของไต','แดง',25,150,'ไต/เก๊าท์'),
  ('BUN','BUN','ค่าไต','แดง',25,150,'ไต/เก๊าท์'),
  ('EGFR','eGFR','การกรองของไต','แดง',40,150,'ไต/เก๊าท์'),
  ('LFT','Liver function test','การทำงานของตับ (ครบชุด)','แดง',160,300,'ตับ'),
  ('ALT','ALT (SGPT)','เอนไซม์ในตับ','แดง',25,200,'ตับ'),
  ('AST','AST (SGOT)','เอนไซม์สร้างจากตับ','แดง',25,200,'ตับ'),
  ('AFP_CONF','AFP confirm','มะเร็งตับ (ยืนยัน)','แดง',300,500,'สารบ่งชี้มะเร็ง'),
  ('AFP','AFP screening','คัดกรองมะเร็งตับ','แดง',170,300,'สารบ่งชี้มะเร็ง'),
  ('CEA','CEA screening','มะเร็งลำไส้/ทางเดินอาหาร','แดง',200,400,'สารบ่งชี้มะเร็ง'),
  ('CEA_CONF','CEA confirm','มะเร็งลำไส้ (ยืนยัน)','แดง',300,500,'สารบ่งชี้มะเร็ง'),
  ('CA199','CA 19-9','มะเร็งตับอ่อน/ท่อน้ำดี','แดง',450,600,'สารบ่งชี้มะเร็ง'),
  ('CA153','CA 15-3','มะเร็งเต้านม','แดง',450,600,'สารบ่งชี้มะเร็ง'),
  ('CA125','CA 125','มะเร็งรังไข่','แดง',450,600,'สารบ่งชี้มะเร็ง'),
  ('PSA_NUM','PSA ตัวเลข','มะเร็งต่อมลูกหมาก (ตัวเลข)','แดง',200,350,'สารบ่งชี้มะเร็ง'),
  ('PSA','PSA screening','คัดกรองมะเร็งต่อมลูกหมาก','แดง',200,300,'สารบ่งชี้มะเร็ง'),
  ('T3','T3','ไทรอยด์','แดง',120,200,'ไทรอยด์'),
  ('T4','T4','ไทรอยด์','แดง',120,200,'ไทรอยด์'),
  ('TSH','TSH','ไทรอยด์','แดง',160,200,'ไทรอยด์'),
  ('ELYTE','Electrolyte','แร่ธาตุในร่างกาย','แดง',140,200,'เกลือแร่'),
  ('PHOS','Phosphorus','ฟอสฟอรัส','แดง',95,100,'เกลือแร่'),
  ('MG','Magnesium','แมกนีเซียม','แดง',95,150,'เกลือแร่'),
  ('CA','Calcium','แคลเซียม','แดง',95,150,'เกลือแร่'),
  ('FERRITIN','Ferritin','โปรตีนเก็บธาตุเหล็ก','แดง',450,800,'เลือด'),
  ('TSAT','Transferrin saturation','โปรตีนขนส่งธาตุเหล็ก','แดง',550,800,'เลือด'),
  ('HBTYPE','Hemoglobin typing','ชนิด/ปริมาณฮีโมโกลบิน','ม่วง',220,400,'เลือด'),
  ('INSULIN','Insulin','อินซูลิน','แดง',900,1500,'ไขมัน/น้ำตาล'),
  ('PAP','Pap smear','ตรวจคัดกรองมะเร็งปากมดลูก',null,70,150,'อื่นๆ')
on conflict (code) do update set name_en=excluded.name_en, name_th=excluded.name_th, tube=excluded.tube, cost=excluded.cost, price=excluded.price, category=excluded.category;

insert into lab_packages (code, name, price, cost, includes, compare_item_codes, items_without_single_price) values
  ('CHK_S','โปรแกรมตรวจสุขภาพชุดเล็ก',999,499,array['ตรวจร่างกายโดยแพทย์','FBS','BUN','Creatinine','Uric acid','Cholesterol','Triglyceride','HDL','LDL','Liver function test','CBC','HBsAg','HBsAb','VDRL','UA','eGFR','BMI']::text[],array['FBS','BUN','CR','URIC','LIPID','LFT','CBC','HBSAG','HBSAB','VDRL','EGFR']::text[],array['UA']::text[]),
  ('CHK_F','โปรแกรมตรวจสุขภาพหญิงชุดใหญ่',1300,799,array['ตรวจร่างกายโดยแพทย์','FBS','BUN','Creatinine','Uric acid','Cholesterol','Triglyceride','HDL','LDL','SGOT','SGPT','ALP','CBC','ABO group','Rh group','HBsAg','HBsAb','AFP','CEA','VDRL','UA','Calcium','eGFR','BMI']::text[],array['FBS','BUN','CR','URIC','LIPID','AST','ALT','CBC','ABO','RH','HBSAG','HBSAB','AFP','CEA','VDRL','CA','EGFR']::text[],array['ALP','UA']::text[]),
  ('CHK_M','โปรแกรมตรวจสุขภาพชายชุดใหญ่',1399,999,array['ตรวจร่างกายโดยแพทย์','FBS','BUN','Creatinine','Uric acid','Cholesterol','Triglyceride','HDL','LDL','SGOT','SGPT','ALP','CBC','ABO group','Rh group','HBsAg','HBsAb','PSA','AFP','CEA','VDRL','UA','Calcium','eGFR','BMI']::text[],array['FBS','BUN','CR','URIC','LIPID','AST','ALT','CBC','ABO','RH','HBSAG','HBSAB','PSA','AFP','CEA','VDRL','CA','EGFR']::text[],array['ALP','UA']::text[]),
  ('LIPID_FBS','Lipid profile + FBS',300,80,array['Cholesterol','Triglyceride','HDL','LDL','FBS']::text[],array['LIPID','FBS']::text[],'{}'::text[]),
  ('ANC1','Program ANC I (ฝากครรภ์)',399,250,array['CBC','HBsAg','Anti-HIV','VDRL','ABO','Rh','OF','DCIP','UA']::text[],array['CBC','HBSAG','HIV','VDRL','ABO','RH']::text[],array['OF','DCIP','UA']::text[]),
  ('ANC2','Program ANC II (ฝากครรภ์)',399,130,array['CBC','HBsAg','Anti-HIV','VDRL']::text[],array['CBC','HBSAG','HIV','VDRL']::text[],'{}'::text[]),
  ('DM','Program เบาหวาน (DM)',400,210,array['FBS','HbA1c','Creatinine','UA','Urine microalbumin','Lipid profile','eGFR']::text[],array['FBS','HBA1C','CR','LIPID','EGFR']::text[],array['UA','Urine microalbumin']::text[]),
  ('HT','Program ความดัน (HT)',400,140,array['FBS','Lipid profile','CBC','Creatinine','Uric acid','UA','eGFR','Potassium']::text[],array['FBS','LIPID','CBC','CR','URIC','EGFR']::text[],array['UA','Potassium']::text[]),
  ('DMHT','Program เบาหวาน + ความดัน',600,260,array['FBS','HbA1c','Creatinine','Uric acid','UA','CBC','eGFR','Urine microalbumin','Lipid profile','Potassium']::text[],array['FBS','HBA1C','CR','URIC','CBC','EGFR','LIPID']::text[],array['UA','Urine microalbumin','Potassium']::text[]),
  ('ELDER','Program ผู้สูงอายุ',300,140,array['FBS','Lipid profile','Creatinine','CBC','UA','eGFR']::text[],array['FBS','LIPID','CR','CBC','EGFR']::text[],array['UA']::text[])
on conflict (code) do update set name=excluded.name, price=excluded.price, cost=excluded.cost, includes=excluded.includes, compare_item_codes=excluded.compare_item_codes, items_without_single_price=excluded.items_without_single_price;
