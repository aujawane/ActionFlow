-- STAGING ONLY. Do not install this helper in production.
--
-- One RPC call is one PostgreSQL transaction, so any failed row rolls back the
-- meeting, transcript segments, and speaker aliases together.

create or replace function public.import_meeting_for_execution_testing(
  p_meeting jsonb,
  p_staging_user_id uuid,
  p_transcript_segments jsonb default '[]'::jsonb,
  p_speaker_aliases jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  meeting_payload jsonb;
  row_payload jsonb;
  meeting_id uuid;
  destination_columns text;
  transcript_count integer := 0;
  alias_count integer := 0;
begin
  if jsonb_typeof(p_meeting) <> 'object' then
    raise exception 'Meeting payload must be a JSON object'
      using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_transcript_segments, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_speaker_aliases, '[]'::jsonb)) <> 'array' then
    raise exception 'Transcript segments and speaker aliases must be JSON arrays'
      using errcode = '22023';
  end if;

  meeting_id := nullif(p_meeting->>'id', '')::uuid;
  if meeting_id is null then
    raise exception 'Meeting payload must contain a valid id'
      using errcode = '22023';
  end if;

  if not exists (select 1 from auth.users where id = p_staging_user_id) then
    raise exception 'Staging auth user % does not exist', p_staging_user_id
      using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.profiles where id = p_staging_user_id) then
    raise exception 'Staging profile % does not exist', p_staging_user_id
      using errcode = 'P0002';
  end if;
  if exists (select 1 from public.meetings where id = meeting_id) then
    raise exception 'Meeting % already exists in staging', meeting_id
      using errcode = '23505';
  end if;

  meeting_payload :=
    p_meeting || jsonb_build_object('id', meeting_id, 'user_id', p_staging_user_id);

  select string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum)
  into destination_columns
  from pg_attribute attribute
  where attribute.attrelid = 'public.meetings'::regclass
    and attribute.attnum > 0
    and not attribute.attisdropped
    and attribute.attgenerated = ''
    and meeting_payload ? attribute.attname;

  if destination_columns is null then
    raise exception 'No compatible destination columns found for meetings'
      using errcode = '42703';
  end if;

  execute format(
    'insert into public.meetings (%1$s)
     select %1$s
     from jsonb_populate_record(null::public.meetings, $1)',
    destination_columns
  )
  using meeting_payload;

  for row_payload in
    select value
    from jsonb_array_elements(coalesce(p_transcript_segments, '[]'::jsonb))
  loop
    if jsonb_typeof(row_payload) <> 'object' then
      raise exception 'Every transcript segment must be a JSON object'
        using errcode = '22023';
    end if;
    row_payload := row_payload || jsonb_build_object('meeting_id', meeting_id);

    select string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum)
    into destination_columns
    from pg_attribute attribute
    where attribute.attrelid = 'public.transcript_segments'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.attgenerated = ''
      and row_payload ? attribute.attname;

    if destination_columns is null then
      raise exception 'No compatible destination columns found for transcript_segments'
        using errcode = '42703';
    end if;

    execute format(
      'insert into public.transcript_segments (%1$s)
       select %1$s
       from jsonb_populate_record(null::public.transcript_segments, $1)',
      destination_columns
    )
    using row_payload;
    transcript_count := transcript_count + 1;
  end loop;

  if jsonb_array_length(coalesce(p_speaker_aliases, '[]'::jsonb)) > 0
     and to_regclass('public.meeting_speaker_aliases') is null then
    raise exception
      'Source has speaker aliases but staging table meeting_speaker_aliases does not exist'
      using errcode = '42P01';
  end if;

  if to_regclass('public.meeting_speaker_aliases') is not null then
    for row_payload in
      select value
      from jsonb_array_elements(coalesce(p_speaker_aliases, '[]'::jsonb))
    loop
      if jsonb_typeof(row_payload) <> 'object' then
        raise exception 'Every speaker alias must be a JSON object'
          using errcode = '22023';
      end if;
      row_payload := row_payload || jsonb_build_object('meeting_id', meeting_id);

      select string_agg(
        format('%I', attribute.attname),
        ', ' order by attribute.attnum
      )
      into destination_columns
      from pg_attribute attribute
      where attribute.attrelid =
        'public.meeting_speaker_aliases'::regclass
        and attribute.attnum > 0
        and not attribute.attisdropped
        and attribute.attgenerated = ''
        and row_payload ? attribute.attname;

      if destination_columns is null then
        raise exception
          'No compatible destination columns found for meeting_speaker_aliases'
          using errcode = '42703';
      end if;

      execute format(
        'insert into public.meeting_speaker_aliases (%1$s)
         select %1$s
         from jsonb_populate_record(
           null::public.meeting_speaker_aliases,
           $1
         )',
        destination_columns
      )
      using row_payload;
      alias_count := alias_count + 1;
    end loop;
  end if;

  return jsonb_build_object(
    'meeting_id', meeting_id,
    'transcript_segments', transcript_count,
    'speaker_aliases', alias_count
  );
end;
$$;

comment on function public.import_meeting_for_execution_testing(
  jsonb,
  uuid,
  jsonb,
  jsonb
) is
  'STAGING-ONLY transactional import of a meeting, transcript, and speaker aliases for execution-intelligence testing.';

revoke all on function public.import_meeting_for_execution_testing(
  jsonb,
  uuid,
  jsonb,
  jsonb
) from public;
revoke all on function public.import_meeting_for_execution_testing(
  jsonb,
  uuid,
  jsonb,
  jsonb
) from anon;
revoke all on function public.import_meeting_for_execution_testing(
  jsonb,
  uuid,
  jsonb,
  jsonb
) from authenticated;
grant execute on function public.import_meeting_for_execution_testing(
  jsonb,
  uuid,
  jsonb,
  jsonb
) to service_role;
