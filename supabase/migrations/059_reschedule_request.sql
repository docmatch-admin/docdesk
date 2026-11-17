-- คนไข้เลือกวันเวลาใหม่เองหลังกดขอเลื่อน (ปุ่มในแชท) แล้วรอเจ้าหน้าที่อนุมัติ
-- { date, slot_id, time_start, time_end, requested_at, conversation_id } · null = ไม่มีคำขอ
alter table appointments add column if not exists reschedule_request jsonb;
