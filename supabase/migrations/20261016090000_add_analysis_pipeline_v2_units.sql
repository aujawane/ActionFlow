-- B0: additive only. The untouched v1 claim uses this default; topology is job-owned.
alter table public.meeting_analysis_jobs
  add column pipeline_version smallint not null default 1
  check (pipeline_version >= 1);

-- Protect v2 even if a future coordinator writes retry_count through a generic
-- job update. V1 assignments retain their existing behavior.
create function public.preserve_analysis_v2_retry_count()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.pipeline_version = 2 then
    new.retry_count = greatest(old.retry_count, new.retry_count);
  end if;
  return new;
end;
$$;
create trigger meeting_analysis_jobs_preserve_v2_retry_count
  before update on public.meeting_analysis_jobs
  for each row execute procedure public.preserve_analysis_v2_retry_count();
revoke all on function public.preserve_analysis_v2_retry_count() from public, anon, authenticated;
grant execute on function public.preserve_analysis_v2_retry_count() to service_role;

create table public.meeting_analysis_job_units (
  job_id uuid not null references public.meeting_analysis_jobs(id) on delete cascade,
  stage text not null check (length(btrim(stage)) > 0),
  unit_key text not null check (length(btrim(unit_key)) > 0),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  result jsonb,
  error text,
  attempt integer not null default 0 check (attempt >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (job_id, stage, unit_key)
);
create index meeting_analysis_job_units_stage_status_idx
  on public.meeting_analysis_job_units(job_id, stage, status);
create trigger meeting_analysis_job_units_set_updated_at
  before update on public.meeting_analysis_job_units
  for each row execute procedure public.set_updated_at();
alter table public.meeting_analysis_job_units enable row level security;
-- No client policies, including SELECT: unit/model payloads are server-only.
revoke all on public.meeting_analysis_job_units from public, anon, authenticated;
grant all on public.meeting_analysis_job_units to service_role;

create function public.claim_meeting_analysis_job_v2(p_meeting_id uuid)
returns jsonb language plpgsql set search_path = public as $$
declare
  claimed_generation bigint;
  claimed_job_id uuid;
begin
  update public.meetings
  set execution_graph_generation = execution_graph_generation + 1
  where id = p_meeting_id and deleted_at is null
  returning execution_graph_generation into claimed_generation;
  if claimed_generation is null then
    raise exception 'Meeting % does not exist or has been deleted', p_meeting_id
      using errcode = 'P0002';
  end if;
  update public.meeting_analysis_jobs
  set status = 'stale', current_stage = 'stale',
      error = 'Superseded by a newer analysis generation.', completed_at = now()
  where meeting_id = p_meeting_id and status in ('queued', 'running');
  insert into public.meeting_analysis_jobs
    (meeting_id, generation, pipeline_version, checkpoint)
  values (p_meeting_id, claimed_generation, 2, '{"checkpointVersion":2}'::jsonb)
  returning id into claimed_job_id;
  return jsonb_build_object('job_id', claimed_job_id, 'generation', claimed_generation);
end;
$$;

-- Shared service-role implementation; wrappers below expose narrow lifecycle operations.
-- Lock meeting BEFORE job, matching both claim RPCs. A concurrent generation claim
-- either follows this transaction or is visible before we mutate: no stale writes.
create function public.mutate_meeting_analysis_job_unit(
  p_job_id uuid, p_stage text, p_unit_key text, p_action text,
  p_attempt integer, p_pipeline_version smallint, p_generation bigint,
  p_result jsonb default null, p_error text default null
) returns public.meeting_analysis_job_units
language plpgsql set search_path = public as $$
declare
  parent public.meeting_analysis_jobs;
  unit public.meeting_analysis_job_units;
  meeting_id_value uuid;
  current_generation bigint;
begin
  if p_action is null or p_action not in ('running', 'completed', 'failed')
     or p_attempt is null or p_attempt < 1
     or p_stage is null or length(btrim(p_stage)) = 0
     or p_unit_key is null or length(btrim(p_unit_key)) = 0 then
    raise exception 'Invalid unit lifecycle input' using errcode = '22023';
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
  if p_pipeline_version is distinct from 2 or parent.pipeline_version <> p_pipeline_version
     or (parent.checkpoint->'checkpointVersion') is distinct from '2'::jsonb then
    raise exception 'Unit execution requires pipeline/checkpoint version 2' using errcode = '22023';
  end if;
  if parent.generation <> current_generation
     or (p_generation is not null and parent.generation <> p_generation)
     or parent.status = 'stale' then
    raise exception 'Stale analysis generation' using errcode = '55000';
  end if;
  if parent.status not in ('queued', 'running') then
    raise exception 'Analysis job is terminal' using errcode = '55000';
  end if;
  select * into unit from public.meeting_analysis_job_units
    where job_id = p_job_id and stage = p_stage and unit_key = p_unit_key;

  if p_action = 'running' then
    insert into public.meeting_analysis_job_units as existing
      (job_id, stage, unit_key, status, attempt, started_at)
    values (p_job_id, p_stage, p_unit_key, 'running', p_attempt, now())
    on conflict (job_id, stage, unit_key) do update
      set status = 'running', error = null, completed_at = null,
          attempt = greatest(existing.attempt, excluded.attempt),
          started_at = coalesce(existing.started_at, excluded.started_at)
      where existing.status <> 'completed'
    returning * into unit;
  else
    if unit.job_id is null or unit.status not in ('running', 'completed') then
      raise exception 'Unit must be running before completion/failure' using errcode = '55000';
    end if;
    update public.meeting_analysis_job_units as existing
    set status = p_action,
        result = case when p_action = 'completed' then p_result else null end,
        error = case when p_action = 'failed' then p_error else null end,
        attempt = greatest(existing.attempt, p_attempt), completed_at = now()
    where job_id = p_job_id and stage = p_stage and unit_key = p_unit_key
      and status <> 'completed'
    returning * into unit;
  end if;
  -- A completed row is immutable: ambiguous retries return the first accepted result.
  if unit.job_id is null then
    select * into unit from public.meeting_analysis_job_units
    where job_id = p_job_id and stage = p_stage and unit_key = p_unit_key;
  end if;
  -- SDK attempts are one-based; UI displays retry_count + 1. Atomic maximum only.
  update public.meeting_analysis_jobs
    set retry_count = greatest(retry_count, p_attempt - 1),
        status = 'running', started_at = coalesce(started_at, now())
    where id = p_job_id;
  return unit;
end;
$$;

create function public.mark_meeting_analysis_job_unit_running(
  p_job_id uuid, p_stage text, p_unit_key text, p_attempt integer,
  p_pipeline_version smallint default 2, p_generation bigint default null
) returns public.meeting_analysis_job_units language sql set search_path = public as $$
  select public.mutate_meeting_analysis_job_unit(
    p_job_id, p_stage, p_unit_key, 'running', p_attempt, p_pipeline_version, p_generation);
$$;
create function public.complete_meeting_analysis_job_unit(
  p_job_id uuid, p_stage text, p_unit_key text, p_attempt integer, p_result jsonb,
  p_pipeline_version smallint default 2, p_generation bigint default null
) returns public.meeting_analysis_job_units language sql set search_path = public as $$
  select public.mutate_meeting_analysis_job_unit(
    p_job_id, p_stage, p_unit_key, 'completed', p_attempt, p_pipeline_version, p_generation, p_result);
$$;
create function public.fail_meeting_analysis_job_unit(
  p_job_id uuid, p_stage text, p_unit_key text, p_attempt integer, p_error text,
  p_pipeline_version smallint default 2, p_generation bigint default null
) returns public.meeting_analysis_job_units language sql set search_path = public as $$
  select public.mutate_meeting_analysis_job_unit(
    p_job_id, p_stage, p_unit_key, 'failed', p_attempt, p_pipeline_version, p_generation, null, p_error);
$$;

revoke all on function public.claim_meeting_analysis_job_v2(uuid) from public, anon, authenticated;
revoke all on function public.mutate_meeting_analysis_job_unit(uuid,text,text,text,integer,smallint,bigint,jsonb,text) from public, anon, authenticated;
revoke all on function public.mark_meeting_analysis_job_unit_running(uuid,text,text,integer,smallint,bigint) from public, anon, authenticated;
revoke all on function public.complete_meeting_analysis_job_unit(uuid,text,text,integer,jsonb,smallint,bigint) from public, anon, authenticated;
revoke all on function public.fail_meeting_analysis_job_unit(uuid,text,text,integer,text,smallint,bigint) from public, anon, authenticated;
grant execute on function public.claim_meeting_analysis_job_v2(uuid) to service_role;
grant execute on function public.mutate_meeting_analysis_job_unit(uuid,text,text,text,integer,smallint,bigint,jsonb,text) to service_role;
grant execute on function public.mark_meeting_analysis_job_unit_running(uuid,text,text,integer,smallint,bigint) to service_role;
grant execute on function public.complete_meeting_analysis_job_unit(uuid,text,text,integer,jsonb,smallint,bigint) to service_role;
grant execute on function public.fail_meeting_analysis_job_unit(uuid,text,text,integer,text,smallint,bigint) to service_role;
