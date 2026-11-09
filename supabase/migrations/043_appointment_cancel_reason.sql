-- ยกเลิกนัดต้องระบุเหตุผล ไม่ลบแถวจริง กู้คืนได้ภายในวันเดียวกัน (เวลาไทย)
alter table appointments add column if not exists cancel_reason text
  check (cancel_reason is null or char_length(cancel_reason) <= 300);
-- patient = คนไข้ขอยกเลิก, doctor = แพทย์ยกเลิก, mistake = ลงนัดผิด (ไม่ส่งข้อความ), other = อื่นๆ
alter table appointments add column if not exists cancel_reason_code text
  check (cancel_reason_code is null or cancel_reason_code in ('patient', 'doctor', 'mistake', 'other'));
alter table appointments add column if not exists cancelled_by uuid references staff(id) on delete set null;
alter table appointments add column if not exists cancelled_at timestamptz;
