alter table public.meetings
add column if not exists execution_graph_generation bigint not null default 0,
add column if not exists last_persisted_execution_generation bigint not null default 0;

alter table public.meeting_tasks
add column if not exists preserve_on_reanalysis boolean not null default false,
add column if not exists manual_override_fields jsonb not null default '[]'::jsonb;

alter table public.meeting_commitments
add column if not exists preserve_on_reanalysis boolean not null default false,
add column if not exists manual_override_fields jsonb not null default '[]'::jsonb;

-- Existing rows may contain edits made before override tracking existed. Retain
-- them conservatively; newly extracted rows start unprotected.
update public.meeting_tasks
set preserve_on_reanalysis = true,
    manual_override_fields = '["status","owner","owners","due_date","due_date_text"]'::jsonb
where preserve_on_reanalysis = false;

update public.meeting_commitments
set preserve_on_reanalysis = true,
    manual_override_fields =
      '["title","description","owner","owners","due_date","due_date_text","status","completion_state"]'::jsonb
where preserve_on_reanalysis = false;

drop index if exists public.meeting_commitments_dedupe_idx;
drop index if exists public.meeting_tasks_dedupe_idx;

create index if not exists meeting_commitments_lookup_idx
on public.meeting_commitments (meeting_id, lower(title));

create index if not exists meeting_tasks_lookup_idx
on public.meeting_tasks (meeting_id, lower(task));

create or replace function public.claim_meeting_execution_analysis(
  p_meeting_id uuid
)
returns bigint
language plpgsql
set search_path = public
as $$
declare
  claimed_generation bigint;
begin
  update public.meetings
  set execution_graph_generation = execution_graph_generation + 1
  where id = p_meeting_id
    and deleted_at is null
  returning execution_graph_generation into claimed_generation;

  if claimed_generation is null then
    raise exception 'Meeting % does not exist or has been deleted', p_meeting_id
      using errcode = 'P0002';
  end if;

  return claimed_generation;
end;
$$;

comment on function public.claim_meeting_execution_analysis(uuid) is
  'Server-only generation claim for execution analysis. Only the latest generation may persist.';

revoke all on function public.claim_meeting_execution_analysis(uuid) from public;
revoke all on function public.claim_meeting_execution_analysis(uuid) from anon;
revoke all on function public.claim_meeting_execution_analysis(uuid) from authenticated;
grant execute on function public.claim_meeting_execution_analysis(uuid) to service_role;

drop function if exists public.replace_meeting_execution_graph(uuid, jsonb, jsonb);

create or replace function public.replace_meeting_execution_graph(
  p_meeting_id uuid,
  p_generation bigint,
  p_commitments jsonb,
  p_tasks jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  current_generation bigint;
  persisted_generation bigint;
  commitment_row jsonb;
  task_row jsonb;
  target_commitment_id uuid;
  target_task_id uuid;
  commitment_refs jsonb := '{}'::jsonb;
  old_commitment_ids uuid[];
  old_task_ids uuid[];
  matched_commitment_ids uuid[] := '{}'::uuid[];
  matched_task_ids uuid[] := '{}'::uuid[];
  commitment_count integer := 0;
  task_count integer := 0;
  retained_task_count integer := 0;
  deleted_task_count integer := 0;
begin
  if jsonb_typeof(coalesce(p_commitments, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_tasks, '[]'::jsonb)) <> 'array' then
    raise exception 'Commitments and tasks must be JSON arrays'
      using errcode = '22023';
  end if;

  select execution_graph_generation, last_persisted_execution_generation
  into current_generation, persisted_generation
  from public.meetings
  where id = p_meeting_id
    and deleted_at is null
  for update;

  if current_generation is null then
    raise exception 'Meeting % does not exist or has been deleted', p_meeting_id
      using errcode = 'P0002';
  end if;

  if current_generation <> p_generation or persisted_generation >= p_generation then
    raise exception 'stale_analysis_run: expected generation %, current %, persisted %',
      p_generation, current_generation, persisted_generation
      using errcode = 'P0001';
  end if;

  select coalesce(array_agg(id), '{}'::uuid[])
  into old_commitment_ids
  from public.meeting_commitments
  where meeting_id = p_meeting_id;

  select coalesce(array_agg(id), '{}'::uuid[])
  into old_task_ids
  from public.meeting_tasks
  where meeting_id = p_meeting_id;

  for commitment_row in
    select value from jsonb_array_elements(coalesce(p_commitments, '[]'::jsonb))
  loop
    target_commitment_id := nullif(commitment_row->>'existing_id', '')::uuid;
    if target_commitment_id is not null then
      if not (target_commitment_id = any(old_commitment_ids))
         or target_commitment_id = any(matched_commitment_ids) then
        raise exception 'Invalid or duplicate existing commitment id %', target_commitment_id
          using errcode = '22023';
      end if;

      update public.meeting_commitments
      set topic_id = nullif(commitment_row->>'topic_id', '')::uuid,
          title = case when manual_override_fields ? 'title'
            then title else commitment_row->>'title' end,
          description = case when manual_override_fields ? 'description'
            then description else nullif(commitment_row->>'description', '') end,
          owner = case when manual_override_fields ? 'owner'
            then owner else nullif(commitment_row->>'owner', '') end,
          owners = case when manual_override_fields ? 'owners'
            then owners else coalesce(commitment_row->'owners', '[]'::jsonb) end,
          due_date = case when manual_override_fields ? 'due_date'
            then due_date else nullif(commitment_row->>'due_date', '')::date end,
          due_date_text = case when manual_override_fields ? 'due_date_text'
            then due_date_text else nullif(commitment_row->>'due_date_text', '') end,
          priority = coalesce(commitment_row->>'priority', priority),
          status = case when manual_override_fields ? 'status' then status else
            case coalesce(commitment_row->>'completion_state', 'open')
              when 'completed' then 'completed'
              when 'blocked' then 'blocked'
              when 'in_progress' then 'in_progress'
              when 'cancelled' then 'dismissed'
              else 'pending'
            end
          end,
          confidence = nullif(commitment_row->>'confidence', '')::numeric,
          source_quote = nullif(commitment_row->>'source_quote', ''),
          source_segment_ids = coalesce(commitment_row->'source_segment_ids', '[]'::jsonb),
          type = commitment_row->>'type',
          completion_state = case when manual_override_fields ? 'completion_state'
            then completion_state
            else coalesce(commitment_row->>'completion_state', 'open')
          end,
          metadata = metadata || jsonb_build_object(
            'client_ref', commitment_row->>'client_ref',
            'evidence_source', commitment_row->>'evidence_source',
            'analysis_generation', p_generation
          )
      where id = target_commitment_id;
    else
      insert into public.meeting_commitments (
        meeting_id, topic_id, title, description, owner, owners, due_date,
        due_date_text, priority, status, confidence, source_quote,
        source_segment_ids, type, completion_state, metadata
      )
      values (
        p_meeting_id,
        nullif(commitment_row->>'topic_id', '')::uuid,
        commitment_row->>'title',
        nullif(commitment_row->>'description', ''),
        nullif(commitment_row->>'owner', ''),
        coalesce(commitment_row->'owners', '[]'::jsonb),
        nullif(commitment_row->>'due_date', '')::date,
        nullif(commitment_row->>'due_date_text', ''),
        coalesce(commitment_row->>'priority', 'medium'),
        case coalesce(commitment_row->>'completion_state', 'open')
          when 'completed' then 'completed'
          when 'blocked' then 'blocked'
          when 'in_progress' then 'in_progress'
          when 'cancelled' then 'dismissed'
          else 'pending'
        end,
        nullif(commitment_row->>'confidence', '')::numeric,
        nullif(commitment_row->>'source_quote', ''),
        coalesce(commitment_row->'source_segment_ids', '[]'::jsonb),
        commitment_row->>'type',
        coalesce(commitment_row->>'completion_state', 'open'),
        jsonb_build_object(
          'client_ref', commitment_row->>'client_ref',
          'evidence_source', commitment_row->>'evidence_source',
          'analysis_generation', p_generation
        )
      )
      returning id into target_commitment_id;
    end if;

    matched_commitment_ids := array_append(matched_commitment_ids, target_commitment_id);
    commitment_refs := commitment_refs ||
      jsonb_build_object(commitment_row->>'client_ref', target_commitment_id::text);
    commitment_count := commitment_count + 1;
  end loop;

  for task_row in
    select value from jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb))
  loop
    target_task_id := nullif(task_row->>'existing_id', '')::uuid;
    if target_task_id is not null then
      if not (target_task_id = any(old_task_ids))
         or target_task_id = any(matched_task_ids) then
        raise exception 'Invalid or duplicate existing task id %', target_task_id
          using errcode = '22023';
      end if;

      update public.meeting_tasks
      set topic_id = nullif(task_row->>'topic_id', '')::uuid,
          commitment_id = case
            when nullif(task_row->>'commitment_ref', '') is null then null
            else nullif(commitment_refs->>(task_row->>'commitment_ref'), '')::uuid
          end,
          task = case when manual_override_fields ? 'task'
            then task else task_row->>'title' end,
          owner = case when manual_override_fields ? 'owner'
            then owner else nullif(task_row->>'owner', '') end,
          owners = case when manual_override_fields ? 'owners'
            then owners else coalesce(task_row->'owners', '[]'::jsonb) end,
          task_type = case when manual_override_fields ? 'task_type'
            then task_type else coalesce(task_row->>'task_type', 'unassigned_work') end,
          priority = case when manual_override_fields ? 'priority'
            then priority else coalesce(task_row->>'priority', 'medium') end,
          suggested_steps = case when manual_override_fields ? 'suggested_steps'
            then suggested_steps else coalesce(task_row->'suggested_steps', '[]'::jsonb) end,
          source_quote = nullif(task_row->>'source_quote', ''),
          source_segment_ids = coalesce(task_row->'source_segment_ids', '[]'::jsonb),
          confidence = nullif(task_row->>'confidence', '')::numeric,
          due_date = case when manual_override_fields ? 'due_date'
            then due_date else nullif(task_row->>'due_date', '')::date end,
          due_date_text = case when manual_override_fields ? 'due_date_text'
            then due_date_text else nullif(task_row->>'due_date_text', '') end,
          inferred = coalesce((task_row->>'inferred')::boolean, false),
          extraction_metadata = extraction_metadata || jsonb_build_object(
            'client_ref', task_row->>'client_ref',
            'commitment_ref', task_row->>'commitment_ref',
            'evidence_source', task_row->>'evidence_source',
            'analysis_generation', p_generation
          )
      where id = target_task_id;
    else
      insert into public.meeting_tasks (
        meeting_id, topic_id, commitment_id, task, owner, owners, task_type,
        priority, suggested_steps, source_quote, source_segment_ids, confidence,
        due_date, due_date_text, workspace_type, workspace_summary, inferred,
        extraction_metadata
      )
      values (
        p_meeting_id,
        nullif(task_row->>'topic_id', '')::uuid,
        case
          when nullif(task_row->>'commitment_ref', '') is null then null
          else nullif(commitment_refs->>(task_row->>'commitment_ref'), '')::uuid
        end,
        task_row->>'title',
        nullif(task_row->>'owner', ''),
        coalesce(task_row->'owners', '[]'::jsonb),
        coalesce(task_row->>'task_type', 'unassigned_work'),
        coalesce(task_row->>'priority', 'medium'),
        coalesce(task_row->'suggested_steps', '[]'::jsonb),
        nullif(task_row->>'source_quote', ''),
        coalesce(task_row->'source_segment_ids', '[]'::jsonb),
        nullif(task_row->>'confidence', '')::numeric,
        nullif(task_row->>'due_date', '')::date,
        nullif(task_row->>'due_date_text', ''),
        coalesce(task_row->>'workspace_type', 'other'),
        nullif(task_row->>'description', ''),
        coalesce((task_row->>'inferred')::boolean, false),
        jsonb_build_object(
          'client_ref', task_row->>'client_ref',
          'commitment_ref', task_row->>'commitment_ref',
          'evidence_source', task_row->>'evidence_source',
          'analysis_generation', p_generation
        )
      )
      returning id into target_task_id;
    end if;

    matched_task_ids := array_append(matched_task_ids, target_task_id);
    task_count := task_count + 1;
  end loop;

  delete from public.meeting_tasks task
  where task.id = any(old_task_ids)
    and not (task.id = any(matched_task_ids))
    and task.preserve_on_reanalysis = false
    and not exists (
      select 1 from public.task_artifacts artifact where artifact.task_id = task.id
    )
    and not exists (
      select 1 from public.task_comments comment_row where comment_row.task_id = task.id
    );
  get diagnostics deleted_task_count = row_count;

  select count(*)
  into retained_task_count
  from public.meeting_tasks task
  where task.id = any(old_task_ids)
    and not (task.id = any(matched_task_ids));

  delete from public.meeting_commitments commitment
  where commitment.id = any(old_commitment_ids)
    and not (commitment.id = any(matched_commitment_ids))
    and commitment.preserve_on_reanalysis = false
    and not exists (
      select 1
      from public.meeting_tasks task
      where task.commitment_id = commitment.id
    );

  update public.meetings
  set last_persisted_execution_generation = p_generation
  where id = p_meeting_id;

  return jsonb_build_object(
    'commitments', commitment_count,
    'tasks', task_count,
    'retained_tasks', retained_task_count,
    'deleted_tasks', deleted_task_count,
    'generation', p_generation
  );
end;
$$;

comment on function public.replace_meeting_execution_graph(uuid, bigint, jsonb, jsonb) is
  'Server-only atomic execution graph merge. Rejects stale generations and preserves user work.';

revoke all on function public.replace_meeting_execution_graph(uuid, bigint, jsonb, jsonb)
from public;
revoke all on function public.replace_meeting_execution_graph(uuid, bigint, jsonb, jsonb)
from anon;
revoke all on function public.replace_meeting_execution_graph(uuid, bigint, jsonb, jsonb)
from authenticated;
grant execute on function public.replace_meeting_execution_graph(uuid, bigint, jsonb, jsonb)
to service_role;
