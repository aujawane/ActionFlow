-- B1: additive only. Pipeline v1 topic writes leave topic_index null; pipeline v2 always
-- populates it with the segmentation ordinal (0-based, model order).
alter table public.meeting_topics
  add column topic_index integer check (topic_index is null or topic_index >= 0);

-- Legacy/v1 rows (null ordinal) are excluded. V2 replaces a meeting's whole set at once.
create unique index meeting_topics_meeting_topic_index_key
  on public.meeting_topics (meeting_id, topic_index) where topic_index is not null;

-- Single-transaction canonical topic/insight replacement for pipeline v2. Validates the
-- caller's job/generation under the same meeting -> job lock order as the B0 unit RPCs,
-- BEFORE any delete. Any uncaught error rolls back the whole call, so the previous canonical
-- set survives. Never writes meeting_analysis_jobs.checkpoint.
--
-- v1 parity boundary. prepareMeetingAnalysis falls back to whole-meeting analysis when its
-- meeting_topics INSERT is rejected, and silently drops a topic's insights when that topic's
-- insight INSERT is rejected. Database rejections of those statements (SQLSTATE classes 22 data
-- exception, 23 integrity violation, 42 schema/access rule) therefore:
--   * topic row:     roll back this whole call and raise TF001 (caller switches to fallback);
--   * insight batch: roll back to that topic's savepoint only.
-- Every other error (connection, timeout/cancel, lock, serialization, resources) is NOT
-- caught: it rolls back the call and surfaces unchanged, so the caller retries.
create function public.replace_meeting_topic_analysis_v2(
  p_job_id uuid, p_generation bigint, p_topics jsonb,
  p_meeting_insights jsonb default '[]'::jsonb
) returns jsonb language plpgsql set search_path = public as $$
declare
  parent public.meeting_analysis_jobs;
  meeting_id_value uuid;
  current_generation bigint;
  topic_value jsonb;
  topic_position bigint;
  topic_row public.meeting_topics;
  insight_value jsonb;
  insight_row public.extracted_insights;
  pending_insights jsonb;
  topics_out jsonb := '[]'::jsonb;
  insights_out jsonb := '[]'::jsonb;
  dropped_topic_indexes jsonb := '[]'::jsonb;
  meeting_insights_dropped boolean := false;
begin
  if p_job_id is null or p_generation is null
     or jsonb_typeof(p_topics) is distinct from 'array'
     or jsonb_typeof(p_meeting_insights) is distinct from 'array'
     or (jsonb_array_length(p_topics) > 0 and jsonb_array_length(p_meeting_insights) > 0) then
    raise exception 'Invalid canonical topic replacement input' using errcode = '22023';
  end if;
  -- Ordinals must be exactly 0..n-1 in array order: no gap, duplicate, or reordering.
  if exists (
    select 1 from jsonb_array_elements(p_topics) with ordinality as t(value, position)
    where jsonb_typeof(t.value) is distinct from 'object'
       or jsonb_typeof(t.value->'insights') is distinct from 'array'
       or jsonb_typeof(t.value->'topic_index') is distinct from 'number'
       or case when (t.value->>'topic_index') ~ '^[0-9]{1,9}$'
            then (t.value->>'topic_index')::bigint <> t.position - 1
            else true end
  ) or exists (
    select 1 from jsonb_array_elements(p_meeting_insights) as i(value)
    where jsonb_typeof(i.value) is distinct from 'object'
  ) then
    raise exception 'Topic ordinals must be contiguous and ordered from 0' using errcode = '22023';
  end if;

  select meeting_id into meeting_id_value from public.meeting_analysis_jobs where id = p_job_id;
  if not found then
    raise exception 'Analysis job does not exist' using errcode = 'P0002';
  end if;
  select execution_graph_generation into current_generation
    from public.meetings where id = meeting_id_value and deleted_at is null for update;
  if not found then
    raise exception 'Meeting does not exist or has been deleted' using errcode = 'P0002';
  end if;
  select * into parent from public.meeting_analysis_jobs where id = p_job_id for update;
  if not found then
    raise exception 'Analysis job does not exist' using errcode = 'P0002';
  end if;
  if parent.pipeline_version <> 2
     or (parent.checkpoint->'checkpointVersion') is distinct from '2'::jsonb then
    raise exception 'Canonical topic replacement requires pipeline/checkpoint version 2'
      using errcode = '22023';
  end if;
  if parent.generation <> current_generation or parent.generation <> p_generation
     or parent.status = 'stale' then
    raise exception 'Stale analysis generation' using errcode = '55000';
  end if;
  if parent.status not in ('queued', 'running') then
    raise exception 'Analysis job is terminal' using errcode = '55000';
  end if;

  -- Same canonical rows (and FK cascades) as pipeline v1's delete-then-insert.
  delete from public.extracted_insights where meeting_id = meeting_id_value;
  delete from public.meeting_topics where meeting_id = meeting_id_value;

  for topic_value, topic_position in
    select t.value, t.position - 1
    from jsonb_array_elements(p_topics) with ordinality as t(value, position)
    order by t.position
  loop
    begin
      insert into public.meeting_topics
        (meeting_id, title, summary, start_timestamp, end_timestamp, segment_ids,
         confidence, separation_reason, topic_index)
      values
        (meeting_id_value, topic_value->>'title', topic_value->>'summary',
         topic_value->>'start_timestamp', topic_value->>'end_timestamp',
         coalesce(topic_value->'segment_ids', '[]'::jsonb),
         (topic_value->>'confidence')::numeric, topic_value->>'separation_reason',
         topic_position)
      returning * into topic_row;
    exception when data_exception or integrity_constraint_violation
                 or syntax_error_or_access_rule_violation then
      -- Raising here aborts the call: the deletes above roll back too.
      raise exception 'Canonical topic insert rejected (%): %', sqlstate, sqlerrm
        using errcode = 'TF001';
    end;
    topics_out := topics_out || jsonb_build_array(to_jsonb(topic_row));

    -- A rejected batch rolls back to this savepoint only, never the canonical set.
    begin
      pending_insights := '[]'::jsonb;
      for insight_value in
        select i.value from jsonb_array_elements(topic_value->'insights') with ordinality as i(value, position)
        order by i.position
      loop
        insert into public.extracted_insights (meeting_id, topic_id, category, content, confidence)
        values (meeting_id_value, topic_row.id, insight_value->>'category',
                insight_value->>'content', (insight_value->>'confidence')::numeric)
        returning * into insight_row;
        pending_insights := pending_insights
          || jsonb_build_array(to_jsonb(insight_row) || jsonb_build_object('topic_index', topic_position));
      end loop;
      insights_out := insights_out || pending_insights;
    exception when data_exception or integrity_constraint_violation
                 or syntax_error_or_access_rule_violation then
      dropped_topic_indexes := dropped_topic_indexes || to_jsonb(topic_position);
    end;
  end loop;

  -- Whole-meeting fallback: topic-less insights, same per-batch drop semantics as v1.
  begin
    pending_insights := '[]'::jsonb;
    for insight_value in
      select i.value from jsonb_array_elements(p_meeting_insights) with ordinality as i(value, position)
      order by i.position
    loop
      insert into public.extracted_insights (meeting_id, topic_id, category, content, confidence)
      values (meeting_id_value, null, insight_value->>'category',
              insight_value->>'content', (insight_value->>'confidence')::numeric)
      returning * into insight_row;
      pending_insights := pending_insights
        || jsonb_build_array(to_jsonb(insight_row) || jsonb_build_object('topic_index', null));
    end loop;
    insights_out := insights_out || pending_insights;
  exception when data_exception or integrity_constraint_violation
               or syntax_error_or_access_rule_violation then
    meeting_insights_dropped := true;
  end;

  return jsonb_build_object(
    'topics', topics_out,
    'insights', insights_out,
    'dropped_insight_topic_indexes', dropped_topic_indexes,
    'meeting_insights_dropped', meeting_insights_dropped
  );
end;
$$;

revoke all on function public.replace_meeting_topic_analysis_v2(uuid,bigint,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.replace_meeting_topic_analysis_v2(uuid,bigint,jsonb,jsonb) to service_role;
