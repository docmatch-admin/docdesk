-- จำนวนครั้งและ token ที่เรียก OpenAI ต่อวัน (ตามเวลาไทย) แสดงในหน้าตั้งค่า
create table if not exists llm_usage_daily (
  day date not null,
  kind text not null check (kind in ('chat', 'embedding')),
  model text not null,
  calls int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  primary key (day, kind, model)
);

alter table llm_usage_daily enable row level security;
drop policy if exists staff_read on llm_usage_daily;
create policy staff_read on llm_usage_daily for select to authenticated using (is_staff());

-- บวกแบบ atomic กันเรียกพร้อมกันแล้วนับหาย
create or replace function record_llm_usage(p_kind text, p_model text, p_input bigint, p_output bigint)
returns void
language sql
set search_path = public
as $$
  insert into llm_usage_daily as u (day, kind, model, calls, input_tokens, output_tokens)
    values ((now() at time zone 'Asia/Bangkok')::date, p_kind, p_model, 1, p_input, p_output)
    on conflict (day, kind, model) do update set
      calls = u.calls + 1,
      input_tokens = u.input_tokens + excluded.input_tokens,
      output_tokens = u.output_tokens + excluded.output_tokens;
$$;

revoke all on function record_llm_usage(text, text, bigint, bigint) from public, anon, authenticated;
grant execute on function record_llm_usage(text, text, bigint, bigint) to service_role;
