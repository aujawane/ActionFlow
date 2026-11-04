-- Pipeline-v2-only canonical normalization persistence. The meeting row is locked before the
-- analysis job, exactly like the B0 unit and B1 topic RPCs. Transcript normalization columns and
-- vocabulary suggestions become visible together; checkpoint.normalization remains a separate,
-- generation-guarded application write after this RPC commits.
create function public.persist_meeting_normalization_v2(
  p_job_id uuid,
  p_generation bigint,
  p_normalized_at timestamptz,
  p_patches jsonb,
  p_vocabulary_suggestions jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  parent public.meeting_analysis_jobs;
  meeting_id_value uuid;
  current_generation bigint;
  project_id_value uuid;
  transcript_count bigint;
  patch_value jsonb;
  suggestion_value jsonb;
  canonical_term_value text;
  observed_alias_value text;
  vocabulary_row public.project_vocabulary;
  inserted_vocabulary_id uuid;
begin
  if p_job_id is null or p_generation is null or p_normalized_at is null
     or jsonb_typeof(p_patches) is distinct from 'array'
     or jsonb_typeof(p_vocabulary_suggestions) is distinct from 'array' then
    raise exception 'Invalid normalization persistence input' using errcode = '22023';
  end if;

  -- This is a full replacement contract for the four normalization columns. Every patch must
  -- carry exactly one segment id, its source invariant, and the replacement outcome.
  if exists (
    select 1
    from jsonb_array_elements(p_patches) as p(value)
    where jsonb_typeof(p.value) is distinct from 'object'
       or not (p.value ?& array[
         'segment_id', 'source_hash', 'source_timestamp', 'normalized_text',
         'normalization_corrections', 'succeeded'
       ])
       or (select count(*) from jsonb_object_keys(p.value)) <> 6
       or jsonb_typeof(p.value->'segment_id') is distinct from 'string'
       or (p.value->>'segment_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or jsonb_typeof(p.value->'source_hash') is distinct from 'string'
       or (p.value->>'source_hash') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(p.value->'source_timestamp') is distinct from 'string'
       or jsonb_typeof(p.value->'normalized_text') not in ('string', 'null')
       or jsonb_typeof(p.value->'normalization_corrections') not in ('array', 'null')
       or jsonb_typeof(p.value->'succeeded') is distinct from 'boolean'
  ) then
    raise exception 'Malformed normalization patch payload' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_patches) as p(value),
         lateral jsonb_array_elements(
           case when jsonb_typeof(p.value->'normalization_corrections') = 'array'
             then p.value->'normalization_corrections' else '[]'::jsonb end
         ) as c(value)
    where jsonb_typeof(c.value) is distinct from 'object'
       or not (c.value ?& array[
         'original_token', 'replacement', 'confidence', 'reason', 'source', 'applied'
       ])
       or (select count(*) from jsonb_object_keys(c.value)) <> 6
       or jsonb_typeof(c.value->'original_token') is distinct from 'string'
       or jsonb_typeof(c.value->'replacement') is distinct from 'string'
       or jsonb_typeof(c.value->'confidence') is distinct from 'number'
       or (c.value->>'confidence')::numeric < 0
       or (c.value->>'confidence')::numeric > 1
       or jsonb_typeof(c.value->'reason') is distinct from 'string'
       or jsonb_typeof(c.value->'source') is distinct from 'string'
       or c.value->>'source' not in ('deterministic', 'model')
       or jsonb_typeof(c.value->'applied') is distinct from 'boolean'
  ) then
    raise exception 'Malformed normalization correction payload' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_patches) as p(value)
    group by (p.value->>'segment_id')::uuid having count(*) > 1
  ) then
    raise exception 'Duplicate normalization segment id' using errcode = '22023';
  end if;

  -- Suggestions preserve the existing application semantics: canonical term whitespace is
  -- trimmed; a blank term is ignored; observed alias may be null; evidence must stay in-meeting.
  if exists (
    select 1
    from jsonb_array_elements(p_vocabulary_suggestions) as v(value)
    where jsonb_typeof(v.value) is distinct from 'object'
       or not (v.value ?& array[
         'canonical_term', 'observed_alias', 'confidence', 'evidence_segment_ids'
       ])
       or (select count(*) from jsonb_object_keys(v.value)) <> 4
       or jsonb_typeof(v.value->'canonical_term') is distinct from 'string'
       or jsonb_typeof(v.value->'observed_alias') not in ('string', 'null')
       or jsonb_typeof(v.value->'confidence') is distinct from 'number'
       or (v.value->>'confidence')::numeric < 0
       or (v.value->>'confidence')::numeric > 1
       or jsonb_typeof(v.value->'evidence_segment_ids') is distinct from 'array'
       or exists (
         select 1 from jsonb_array_elements(v.value->'evidence_segment_ids') as e(value)
         where jsonb_typeof(e.value) is distinct from 'string'
            or (e.value#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       )
  ) then
    raise exception 'Malformed normalization vocabulary payload' using errcode = '22023';
  end if;

  -- Unlocked identity lookup only discovers the meeting row to lock. The authoritative job row
  -- is read again after the meeting lock, so a concurrent generation claim cannot pass unseen.
  select meeting_id into meeting_id_value
  from public.meeting_analysis_jobs where id = p_job_id;
  if not found then
    raise exception 'Analysis job does not exist' using errcode = 'P0002';
  end if;

  select execution_graph_generation, project_id
  into current_generation, project_id_value
  from public.meetings
  where id = meeting_id_value and deleted_at is null
  for update;
  if not found then
    raise exception 'Meeting does not exist or has been deleted' using errcode = 'P0002';
  end if;

  select * into parent
  from public.meeting_analysis_jobs where id = p_job_id
  for update;
  if not found or parent.meeting_id <> meeting_id_value then
    raise exception 'Analysis job/meeting identity mismatch' using errcode = 'P0002';
  end if;
  if parent.pipeline_version <> 2
     or (parent.checkpoint->'checkpointVersion') is distinct from '2'::jsonb
     or (parent.checkpoint->>'v2Topology') is distinct from 'b2' then
    raise exception 'Normalization persistence requires B2 pipeline/checkpoint version 2'
      using errcode = '22023';
  end if;
  if parent.generation <> current_generation or parent.generation <> p_generation
     or parent.status = 'stale' then
    raise exception 'Stale analysis generation' using errcode = '55000';
  end if;
  if parent.status not in ('queued', 'running') then
    raise exception 'Analysis job is terminal' using errcode = '55000';
  end if;

  -- Lock the complete current source set only after meeting -> job. The transcript replacement
  -- RPC also takes the meeting lock first, so it cannot replace rows between this validation and
  -- mutation. Direct row writers are blocked by these row locks.
  perform id from public.transcript_segments
  where meeting_id = meeting_id_value order by id for update;
  get diagnostics transcript_count = row_count;

  if transcript_count <> jsonb_array_length(p_patches) then
    raise exception 'Normalization source segment set changed' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_patches) as p(value)
    left join public.transcript_segments s
      on s.id = (p.value->>'segment_id')::uuid and s.meeting_id = meeting_id_value
    where s.id is null
  ) then
    raise exception 'Normalization patch contains a foreign or unexpected segment'
      using errcode = '22023';
  end if;

  -- The durable plan's global SHA-256 remains the application-level batch invariant. These
  -- database-native per-row checks close the final read-to-write race without passing raw text:
  -- SHA-256(length-prefixed normalized-speaker, participant, raw text) plus exact timestamptz.
  if exists (
    select 1
    from jsonb_array_elements(p_patches) as p(value)
    join public.transcript_segments s on s.id = (p.value->>'segment_id')::uuid
    where s.meeting_id <> meeting_id_value
       or p.value->>'source_hash' <> encode(sha256(convert_to(
         octet_length(coalesce(nullif(btrim(s.participant_name), ''), nullif(btrim(s.speaker), ''), 'Unknown Speaker'))::text
           || ':' || coalesce(nullif(btrim(s.participant_name), ''), nullif(btrim(s.speaker), ''), 'Unknown Speaker') || '|'
           || octet_length(coalesce(s.participant_name, ''))::text || ':' || coalesce(s.participant_name, '') || '|'
           || octet_length(s.text)::text || ':' || s.text
       , 'UTF8')), 'hex')
       or (p.value->>'source_timestamp')::timestamptz is distinct from s."timestamp"
  ) then
    raise exception 'Normalization transcript source changed' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_vocabulary_suggestions) as v(value),
         lateral jsonb_array_elements(v.value->'evidence_segment_ids') as e(value)
    left join public.transcript_segments s
      on s.id = (e.value#>>'{}')::uuid and s.meeting_id = meeting_id_value
    where s.id is null
  ) then
    raise exception 'Vocabulary evidence contains a foreign or unexpected segment'
      using errcode = '22023';
  end if;

  update public.transcript_segments as s
  set normalized_text = case when p.value->'normalized_text' = 'null'::jsonb
        then null else p.value->>'normalized_text' end,
      normalization_corrections = case when p.value->'normalization_corrections' = 'null'::jsonb
        then null else p.value->'normalization_corrections' end,
      normalized_at = case
        when not (p.value->>'succeeded')::boolean then null
        when s.normalized_at is not null and s.normalization_failed_at is null
          and s.normalized_text is not distinct from
            (case when p.value->'normalized_text' = 'null'::jsonb then null else p.value->>'normalized_text' end)
          and s.normalization_corrections is not distinct from
            (case when p.value->'normalization_corrections' = 'null'::jsonb
              then null else p.value->'normalization_corrections' end)
          then s.normalized_at
        else p_normalized_at end,
      normalization_failed_at = case
        when (p.value->>'succeeded')::boolean then null
        when s.normalization_failed_at is not null and s.normalized_at is null
          and s.normalized_text is not distinct from
            (case when p.value->'normalized_text' = 'null'::jsonb then null else p.value->>'normalized_text' end)
          and s.normalization_corrections is not distinct from
            (case when p.value->'normalization_corrections' = 'null'::jsonb
              then null else p.value->'normalization_corrections' end)
          then s.normalization_failed_at
        else p_normalized_at end
  from jsonb_array_elements(p_patches) as p(value)
  where s.id = (p.value->>'segment_id')::uuid and s.meeting_id = meeting_id_value;

  if project_id_value is not null and jsonb_array_length(p_vocabulary_suggestions) > 0 then
    -- Serialize normalization suggestion learning per project after all generation/source locks.
    perform id from public.projects where id = project_id_value for update;
    for suggestion_value in
      select v.value from jsonb_array_elements(p_vocabulary_suggestions) with ordinality as v(value, position)
      order by v.position
    loop
      canonical_term_value := btrim(suggestion_value->>'canonical_term');
      if canonical_term_value = '' then continue; end if;
      observed_alias_value := case when suggestion_value->'observed_alias' = 'null'::jsonb
        then null else suggestion_value->>'observed_alias' end;

      vocabulary_row := null;
      select * into vocabulary_row
      from public.project_vocabulary
      where project_id = project_id_value and lower(canonical_term) = lower(canonical_term_value)
      for update;

      if not found then
        inserted_vocabulary_id := null;
        insert into public.project_vocabulary (
          project_id, canonical_term, aliases, term_type, source, status, confidence,
          evidence_meeting_id, evidence_segment_ids
        ) values (
          project_id_value, canonical_term_value,
          case when observed_alias_value is null then '{}'::text[] else array[observed_alias_value] end,
          'other', 'ai_suggested', 'suggested', (suggestion_value->>'confidence')::numeric,
          meeting_id_value, suggestion_value->'evidence_segment_ids'
        ) on conflict (project_id, lower(canonical_term)) do nothing
        returning id into inserted_vocabulary_id;

        if inserted_vocabulary_id is not null then continue; end if;
        select * into vocabulary_row
        from public.project_vocabulary
        where project_id = project_id_value and lower(canonical_term) = lower(canonical_term_value)
        for update;
      end if;

      if vocabulary_row.status = 'suggested' and observed_alias_value is not null
         and not (observed_alias_value = any(vocabulary_row.aliases)) then
        update public.project_vocabulary
        set aliases = array_append(aliases, observed_alias_value)
        where id = vocabulary_row.id;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'segment_count', transcript_count,
    'vocabulary_candidate_count', jsonb_array_length(p_vocabulary_suggestions)
  );
end;
$$;

revoke all on function public.persist_meeting_normalization_v2(uuid,bigint,timestamptz,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_meeting_normalization_v2(uuid,bigint,timestamptz,jsonb,jsonb)
  to service_role;
