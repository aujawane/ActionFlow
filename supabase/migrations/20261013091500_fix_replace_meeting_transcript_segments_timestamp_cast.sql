-- Follow-up fix to the previous migration (20261013090000), found empirically while running the
-- concurrency test against staging, not by inspection: inserting seg->>'timestamp' (plain jsonb
-- text extraction, no cast) into transcript_segments."timestamp" fails with
-- "column \"timestamp\" is of type timestamp with time zone but expression is of type text" --
-- Postgres does NOT perform this cast implicitly inside an INSERT ... SELECT in this context, so
-- the previous migration's "let Postgres coerce it either way" assumption was wrong. The live
-- column is confirmed timestamptz by this exact error; adding an explicit cast.
create or replace function public.replace_meeting_transcript_segments(
  p_meeting_id uuid,
  p_segments jsonb
)
returns setof public.transcript_segments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exists boolean;
begin
  select true into v_exists from public.meetings where id = p_meeting_id for update;
  if v_exists is null then
    raise exception 'meeting_not_found' using errcode = 'P0002';
  end if;

  delete from public.transcript_segments where meeting_id = p_meeting_id;

  return query
  insert into public.transcript_segments (meeting_id, speaker, participant_name, text, "timestamp", raw_payload)
  select
    p_meeting_id,
    seg->>'speaker',
    seg->>'participant_name',
    seg->>'text',
    (seg->>'timestamp')::timestamptz,
    coalesce(seg->'raw_payload', '{}'::jsonb)
  from jsonb_array_elements(p_segments) as seg
  returning *;
end;
$$;

revoke all on function public.replace_meeting_transcript_segments(uuid, jsonb) from public;
revoke all on function public.replace_meeting_transcript_segments(uuid, jsonb) from anon;
revoke all on function public.replace_meeting_transcript_segments(uuid, jsonb) from authenticated;
grant execute on function public.replace_meeting_transcript_segments(uuid, jsonb) to service_role;
