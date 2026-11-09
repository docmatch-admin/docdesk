-- {date} มีคำว่า "วัน" อยู่แล้ว (วันจันทร์ที่ ...) เทมเพลตเริ่มต้นเดิมเขียน "วัน{date}" ซ้ำ
update settings set value = jsonb_set(value, '{template_th}', to_jsonb(replace(value->>'template_th', 'วัน{date}', '{date}')))
where key = 'appointment_settings' and value->>'template_th' like '%วัน{date}%';
