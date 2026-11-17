-- คนไข้เลือกวันเวลาใหม่เองหลังกดขอเลื่อน (ปุ่มในแชท) แล้วรอเจ้าหน้าที่อนุมัติ
-- { date, slot_id, time_start, time_end, requested_at, conversation_id } · null = ไม่มีคำขอ
alter table appointments add column if not exists reschedule_request jsonb;

-- คำขอที่เข้ามาก่อนรัน migration นี้ (เก็บไว้แค่ในประวัตินัด): เติมคำขอจากประวัติล่าสุด ให้มีปุ่มอนุมัติ
update appointments a set reschedule_request = jsonb_build_object(
    'date', ev.req->>'date',
    'slot_id', h.slot_id,
    'time_start', to_char(h.start_time, 'HH24:MI'),
    'time_end', to_char(h.end_time, 'HH24:MI'),
    'requested_at', ev.created_at,
    'conversation_id', a.conversation_id)
from (
  select distinct on (appointment_id) appointment_id, created_at, detail->'requested' as req
  from appointment_events
  where kind = 'reschedule_requested' and detail ? 'requested'
  order by appointment_id, created_at desc
) ev
join clinic_hours h on true
where a.id = ev.appointment_id
  and a.status = 'reschedule_requested'
  and a.reschedule_request is null
  and (ev.req->>'date')::date >= (now() at time zone 'Asia/Bangkok')::date
  and h.weekday = extract(dow from (ev.req->>'date')::date)
  and to_char(h.start_time, 'HH24:MI') = split_part(ev.req->>'time', '–', 1);
