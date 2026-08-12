-- Phase 7: deliverable lifecycle (acceptance + safe versioning).
--
-- Audit findings that shaped this migration (see Phase 7 report for full detail):
--   * task_artifacts already accumulates one row per REGENERATION (generateTaskDeliverable
--     inserts a new row with version = previous + 1, scoped per (task_id, deliverable_type)).
--     Versioning-on-regenerate already existed; nothing new was needed for that part.
--   * The one edit path (PATCH /api/tasks/[id]/deliverable) mutated the SAME row in place --
--     the one place that actually violated "never silently overwrite a user edit". Fixed at the
--     application layer to go through the same insert-a-new-version RPC added here.
--   * There was no acceptance concept at all: no status value, no accepted_at/accepted_by.
--
-- Design: acceptance is tracked via accepted_at/accepted_by rather than folding it into the
-- existing `status` column (which already means "how this version's content was produced":
-- generated | edited | failed -- a different, orthogonal dimension). accepted_at IS NOT NULL is
-- the single source of truth for "this version is accepted". This avoids overloading `status`
-- and needed no change to the existing task_artifacts_status_check constraint.

alter table public.task_artifacts
  add column if not exists accepted_at timestamptz,
  add column if not exists accepted_by uuid references auth.users (id) on delete set null;

create index if not exists task_artifacts_task_deliverable_version_idx
on public.task_artifacts (task_id, deliverable_type, version desc);

-- Inserts the next version for (task_id, deliverable_type) -- used by generation, regeneration,
-- manual edits, and "restore a prior version" (which just re-inserts old content as a new
-- version). If the version being superseded was accepted, the task is reopened to 'pending':
-- an accepted deliverable that stops being current should not leave the task silently marked
-- complete against an unreviewed draft. This is a deliberate simplification (see report) --
-- reopening always resets to 'pending' rather than restoring the exact pre-acceptance status,
-- which would require additional storage for a comparatively rare edge case.
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
  -- Two separate lookups, deliberately: v_current (non-failed) decides whether an accepted
  -- version is being superseded (a failed attempt never supersedes anything); v_latest_version
  -- (any status) decides the next version NUMBER, so a failed attempt still consumes its own
  -- version slot instead of colliding with the next successful one that follows it.
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
    update public.meeting_tasks
    set status = 'pending'
    where id = p_task_id and status = 'completed';
  end if;

  return v_new;
end;
$$;

comment on function public.create_deliverable_version(uuid, text, text, text, text, text, jsonb) is
  'Insert the next deliverable version for a task; reopens the task if it supersedes a currently-accepted version.';

revoke all on function public.create_deliverable_version(uuid, text, text, text, text, text, jsonb) from public;
revoke all on function public.create_deliverable_version(uuid, text, text, text, text, text, jsonb) from anon;
revoke all on function public.create_deliverable_version(uuid, text, text, text, text, text, jsonb) from authenticated;
grant execute on function public.create_deliverable_version(uuid, text, text, text, text, text, jsonb) to service_role;

-- Accepts one deliverable version and completes its task. Multiple deliverables/types on the
-- same task may each be independently accepted -- this never touches any other artifact row.
create or replace function public.accept_deliverable(
  p_artifact_id uuid,
  p_actor_id uuid
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
  where id = p_artifact_id and status <> 'failed'
  for update;

  if v_artifact.id is null then
    raise exception 'artifact_not_found' using errcode = 'P0002';
  end if;

  update public.task_artifacts
  set accepted_at = timezone('utc', now()), accepted_by = p_actor_id
  where id = p_artifact_id
  returning * into v_artifact;

  update public.meeting_tasks
  set status = 'completed'
  where id = v_artifact.task_id;

  return v_artifact;
end;
$$;

comment on function public.accept_deliverable(uuid, uuid) is
  'Marks a deliverable version accepted and completes its task, atomically.';

revoke all on function public.accept_deliverable(uuid, uuid) from public;
revoke all on function public.accept_deliverable(uuid, uuid) from anon;
revoke all on function public.accept_deliverable(uuid, uuid) from authenticated;
grant execute on function public.accept_deliverable(uuid, uuid) to service_role;

-- Reverses acceptance on one version and reopens its task (only if the task is currently
-- 'completed' -- if the user already completed the task some other way after accepting, this
-- does not clobber that).
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

  update public.meeting_tasks
  set status = 'pending'
  where id = v_artifact.task_id and status = 'completed';

  return v_artifact;
end;
$$;

comment on function public.reopen_deliverable(uuid) is
  'Reverses acceptance on a deliverable version and reopens its task if still completed.';

revoke all on function public.reopen_deliverable(uuid) from public;
revoke all on function public.reopen_deliverable(uuid) from anon;
revoke all on function public.reopen_deliverable(uuid) from authenticated;
grant execute on function public.reopen_deliverable(uuid) to service_role;
