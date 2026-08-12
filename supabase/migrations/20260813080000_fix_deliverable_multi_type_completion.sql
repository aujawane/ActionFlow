-- Phase 7.1: multi-deliverable task-completion audit fix.
--
-- Bug found: create_deliverable_version and reopen_deliverable each reopened the task
-- unconditionally whenever the version they touched had been accepted -- with no regard for
-- whether a DIFFERENT deliverable_type on the same task still had a current accepted version.
-- Example: Email Draft accepted, Research Report accepted, task completed. Reopening Email
-- Draft alone incorrectly reopened the task even though Research Report was still accepted.
--
-- Canonical invariant (unchanged from the Phase 7 report's intent, now actually enforced):
--   A task is completed by the deliverable lifecycle when AT LEAST ONE CURRENT (latest
--   non-failed version per (task_id, deliverable_type)) deliverable is accepted.
--
-- This migration adds one canonical function expressing that rule and makes both write paths
-- consult it instead of each re-deriving (and getting wrong) their own local answer.

create or replace function public.task_has_accepted_current_deliverable(
  p_task_id uuid
)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from (
      select distinct on (deliverable_type) *
      from public.task_artifacts
      where task_id = p_task_id and status <> 'failed'
      order by deliverable_type, version desc
    ) current_versions
    where current_versions.accepted_at is not null
  );
$$;

comment on function public.task_has_accepted_current_deliverable(uuid) is
  'Canonical rule: true if any (task_id, deliverable_type) lineage''s current (latest non-failed) version is accepted. The single source of truth every deliverable-lifecycle write path must consult before reopening a task.';

revoke all on function public.task_has_accepted_current_deliverable(uuid) from public;
revoke all on function public.task_has_accepted_current_deliverable(uuid) from anon;
revoke all on function public.task_has_accepted_current_deliverable(uuid) from authenticated;
grant execute on function public.task_has_accepted_current_deliverable(uuid) to service_role;

-- create_deliverable_version: only reopen the task if, AFTER inserting the new version, no
-- current deliverable (of any type) is still accepted. Previously this reopened the task purely
-- because the version being superseded happened to be accepted, ignoring other types entirely.
create or replace function public.create_deliverable_version(
  p_task_id uuid,
  p_deliverable_type text,
  p_artifact_type text,
  p_title text,
  p_content text,
  p_status text,
  p_metadata jsonb
)
returns public.task_artifacts
language plpgsql
set search_path = public
as $$
declare
  v_current public.task_artifacts%rowtype;
  v_latest_version integer;
  v_next_version integer;
  v_new public.task_artifacts%rowtype;
begin
  select *
  into v_current
  from public.task_artifacts
  where task_id = p_task_id
    and deliverable_type = p_deliverable_type
    and status <> 'failed'
  order by version desc
  limit 1
  for update;

  select max(version)
  into v_latest_version
  from public.task_artifacts
  where task_id = p_task_id
    and deliverable_type = p_deliverable_type;

  v_next_version := coalesce(v_latest_version, 0) + 1;

  insert into public.task_artifacts (
    task_id, artifact_type, deliverable_type, title, content, version, status, metadata
  ) values (
    p_task_id, p_artifact_type, p_deliverable_type, p_title, p_content, v_next_version,
    p_status, coalesce(p_metadata, '{}'::jsonb)
  )
  returning * into v_new;

  if v_current.id is not null and v_current.accepted_at is not null then
    if not public.task_has_accepted_current_deliverable(p_task_id) then
      update public.meeting_tasks
      set status = 'pending'
      where id = p_task_id and status = 'completed';
    end if;
  end if;

  return v_new;
end;
$$;

comment on function public.create_deliverable_version(uuid, text, text, text, text, text, jsonb) is
  'Insert the next deliverable version for a task; reopens the task only if no current deliverable (any type) remains accepted after this write.';

-- reopen_deliverable: same fix -- only reopen the task if no OTHER current deliverable is
-- still accepted after this one is un-accepted.
create or replace function public.reopen_deliverable(
  p_artifact_id uuid
)
returns public.task_artifacts
language plpgsql
set search_path = public
as $$
declare
  v_artifact public.task_artifacts%rowtype;
begin
  select * into v_artifact
  from public.task_artifacts
  where id = p_artifact_id
  for update;

  if v_artifact.id is null then
    raise exception 'artifact_not_found' using errcode = 'P0002';
  end if;

  update public.task_artifacts
  set accepted_at = null, accepted_by = null
  where id = p_artifact_id
  returning * into v_artifact;

  if not public.task_has_accepted_current_deliverable(v_artifact.task_id) then
    update public.meeting_tasks
    set status = 'pending'
    where id = v_artifact.task_id and status = 'completed';
  end if;

  return v_artifact;
end;
$$;

comment on function public.reopen_deliverable(uuid) is
  'Reverses acceptance on a deliverable version; reopens its task only if no current deliverable (any type) remains accepted.';
