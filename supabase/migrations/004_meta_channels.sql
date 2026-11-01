-- เฟส 2: Facebook Messenger + Instagram Direct
insert into channels (type, name) values
  ('facebook',  'Facebook แฮปปี้เวลล์ คลินิกเวชกรรม'),
  ('instagram', 'Instagram แฮปปี้เวลล์ คลินิก')
on conflict do nothing;
