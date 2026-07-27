-- Additive project-first execution hierarchy.
-- Do not apply to production until staging verification is complete.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  description text,
  goal text,
  status text not null default 'planning' check (
    status in ('planning', 'active', 'on_hold', 'completed', 'archived')
  ),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists projects_owner_status_idx
on public.projects (owner_id, status);

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
before update on public.projects
for each row execute procedure public.set_updated_at();

alter table public.projects enable row level security;

drop policy if exists "projects_owner_all" on public.projects;
create policy "projects_owner_all"
on public.projects
for all
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

alter table public.meetings
add column if not exists project_id uuid references public.projects (id) on delete set null;

alter table public.meeting_commitments
add column if not exists project_id uuid references public.projects (id) on delete set null,
add column if not exists converted_to_task_id uuid
  references public.meeting_tasks (id) on delete set null;

alter table public.meeting_tasks
add column if not exists project_id uuid references public.projects (id) on delete set null,
add column if not exists position integer not null default 0 check (position >= 0);

alter table public.meeting_tasks
drop constraint if exists meeting_tasks_status_check;

alter table public.meeting_tasks
add constraint meeting_tasks_status_check
check (status in ('pending', 'in_progress', 'completed', 'dismissed', 'blocked'));

create index if not exists meetings_project_id_idx
on public.meetings (project_id);

create index if not exists meeting_commitments_project_status_idx
on public.meeting_commitments (project_id, status);

create index if not exists meeting_commitments_active_project_idx
on public.meeting_commitments (project_id, converted_to_task_id);

create index if not exists meeting_tasks_project_commitment_position_idx
on public.meeting_tasks (project_id, commitment_id, position);

-- Meeting assignment is the source of truth for graph rows. The trigger makes
-- the existing generation-locked replacement RPC project-aware without
-- trusting model output or changing its public signature.
create or replace function public.sync_execution_row_project()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select project_id
  into new.project_id
  from public.meetings
  where id = new.meeting_id;
  return new;
end;
$$;

drop trigger if exists meeting_commitments_sync_project on public.meeting_commitments;
create trigger meeting_commitments_sync_project
before insert or update of meeting_id, project_id on public.meeting_commitments
for each row execute procedure public.sync_execution_row_project();

drop trigger if exists meeting_tasks_sync_project on public.meeting_tasks;
create trigger meeting_tasks_sync_project
before insert or update of meeting_id, project_id on public.meeting_tasks
for each row execute procedure public.sync_execution_row_project();

-- A narrow commitment converted by deterministic consolidation may correspond
-- to an older protected commitment row. The app embeds an explicit
-- "existing:<uuid>" marker in consolidated_from_refs after evidence matching.
-- This trigger transfers manually protected fields to the new task and retains
-- the old row as traceable history instead of deleting user work.
create or replace function public.preserve_converted_commitment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  marker text;
  source_commitment public.meeting_commitments%rowtype;
begin
  select value #>> '{}'
  into marker
  from jsonb_array_elements(
    coalesce(new.extraction_metadata->'consolidated_from_refs', '[]'::jsonb)
  ) value
  where value #>> '{}' like 'existing:%'
  limit 1;

  if marker is null then
    return new;
  end if;

  select * into source_commitment
  from public.meeting_commitments
  where id = substring(marker from 10)::uuid
    and meeting_id = new.meeting_id
  for update;

  if source_commitment.id is null then
    return new;
  end if;

  update public.meeting_tasks
  set task = case
        when source_commitment.manual_override_fields ? 'title'
          then source_commitment.title else new.task end,
      workspace_summary = case
        when source_commitment.manual_override_fields ? 'description'
          then source_commitment.description else new.workspace_summary end,
      owner = case
        when source_commitment.manual_override_fields ? 'owner'
          then source_commitment.owner else new.owner end,
      owners = case
        when source_commitment.manual_override_fields ? 'owners'
          then source_commitment.owners else new.owners end,
      due_date = case
        when source_commitment.manual_override_fields ? 'due_date'
          then source_commitment.due_date else new.due_date end,
      due_date_text = case
        when source_commitment.manual_override_fields ? 'due_date_text'
          then source_commitment.due_date_text else new.due_date_text end,
      priority = case
        when source_commitment.manual_override_fields ? 'priority'
          then source_commitment.priority else new.priority end,
      status = case
        when source_commitment.manual_override_fields ? 'status'
          then source_commitment.status else new.status end,
      preserve_on_reanalysis =
        new.preserve_on_reanalysis or source_commitment.preserve_on_reanalysis,
      manual_override_fields = (
        select coalesce(jsonb_agg(distinct field), '[]'::jsonb)
        from jsonb_array_elements(
          coalesce(new.manual_override_fields, '[]'::jsonb) ||
          case
            when source_commitment.manual_override_fields ? 'title'
              then (source_commitment.manual_override_fields - 'title') || '"task"'::jsonb
            else source_commitment.manual_override_fields
          end
        ) field
      )
  where id = new.id;

  update public.meeting_commitments
  set converted_to_task_id = new.id
  where id = source_commitment.id;

  return new;
end;
$$;

drop trigger if exists meeting_tasks_preserve_converted_commitment
on public.meeting_tasks;
create trigger meeting_tasks_preserve_converted_commitment
after insert or update of extraction_metadata on public.meeting_tasks
for each row execute procedure public.preserve_converted_commitment();

update public.meeting_commitments commitment
set project_id = meeting.project_id
from public.meetings meeting
where meeting.id = commitment.meeting_id
  and commitment.project_id is distinct from meeting.project_id;

update public.meeting_tasks task
set project_id = meeting.project_id
from public.meetings meeting
where meeting.id = task.meeting_id
  and task.project_id is distinct from meeting.project_id;

create table if not exists public.task_dependencies (
  task_id uuid not null references public.meeting_tasks (id) on delete cascade,
  depends_on_task_id uuid not null references public.meeting_tasks (id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);

create index if not exists task_dependencies_prerequisite_idx
on public.task_dependencies (depends_on_task_id);

alter table public.task_dependencies enable row level security;

drop policy if exists "task_dependencies_owner_all" on public.task_dependencies;
create policy "task_dependencies_owner_all"
on public.task_dependencies
for all
using (
  exists (
    select 1
    from public.meeting_tasks task
    join public.meetings meeting on meeting.id = task.meeting_id
    where task.id = task_dependencies.task_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
)
with check (
  exists (
    select 1
    from public.meeting_tasks task
    join public.meeting_tasks prerequisite
      on prerequisite.id = task_dependencies.depends_on_task_id
    join public.meetings meeting on meeting.id = task.meeting_id
    where task.id = task_dependencies.task_id
      and prerequisite.project_id is not distinct from task.project_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
);

create or replace function public.reject_task_dependency_cycle()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    with recursive reachable(task_id) as (
      select new.depends_on_task_id
      union
      select dependency.depends_on_task_id
      from public.task_dependencies dependency
      join reachable on dependency.task_id = reachable.task_id
    )
    select 1 from reachable where task_id = new.task_id
  ) then
    raise exception 'task_dependency_cycle'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists task_dependencies_reject_cycle on public.task_dependencies;
create trigger task_dependencies_reject_cycle
before insert or update on public.task_dependencies
for each row execute procedure public.reject_task_dependency_cycle();

create or replace function public.replace_task_dependencies(
  p_task_id uuid,
  p_depends_on_task_ids uuid[]
)
returns void
language plpgsql
set search_path = public
as $$
declare
  task_row public.meeting_tasks%rowtype;
begin
  select * into task_row
  from public.meeting_tasks
  where id = p_task_id
  for update;

  if task_row.id is null then
    raise exception 'Task does not exist' using errcode = 'P0002';
  end if;

  if p_task_id = any(coalesce(p_depends_on_task_ids, '{}'::uuid[])) then
    raise exception 'Task cannot depend on itself' using errcode = '23514';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_depends_on_task_ids, '{}'::uuid[]))
      as requested(dependency_id)
    left join public.meeting_tasks dependency
      on dependency.id = requested.dependency_id
    where dependency.id is null
       or dependency.project_id is distinct from task_row.project_id
       or dependency.commitment_id is distinct from task_row.commitment_id
  ) then
    raise exception 'Dependencies must belong to the same milestone'
      using errcode = '22023';
  end if;

  delete from public.task_dependencies where task_id = p_task_id;
  insert into public.task_dependencies (task_id, depends_on_task_id)
  select p_task_id, dependency_id
  from (
    select distinct unnest(
      coalesce(p_depends_on_task_ids, '{}'::uuid[])
    ) as dependency_id
  ) dependencies;
end;
$$;

comment on function public.replace_task_dependencies(uuid, uuid[]) is
  'Server-only atomic dependency replacement with same-milestone and cycle checks.';

revoke all on function public.replace_task_dependencies(uuid, uuid[]) from public;
revoke all on function public.replace_task_dependencies(uuid, uuid[]) from anon;
revoke all on function public.replace_task_dependencies(uuid, uuid[]) from authenticated;
grant execute on function public.replace_task_dependencies(uuid, uuid[]) to service_role;

create table if not exists public.commitment_comments (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null references public.meeting_commitments (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'system')),
  message text not null check (length(trim(message)) > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists commitment_comments_commitment_created_idx
on public.commitment_comments (commitment_id, created_at);

alter table public.commitment_comments enable row level security;

drop policy if exists "commitment_comments_owner_select" on public.commitment_comments;
create policy "commitment_comments_owner_select"
on public.commitment_comments
for select
using (
  exists (
    select 1
    from public.meeting_commitments commitment
    join public.meetings meeting on meeting.id = commitment.meeting_id
    where commitment.id = commitment_comments.commitment_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
);

drop policy if exists "commitment_comments_owner_insert" on public.commitment_comments;
create policy "commitment_comments_owner_insert"
on public.commitment_comments
for insert
with check (
  role = 'user'
  and user_id = auth.uid()
  and exists (
    select 1
    from public.meeting_commitments commitment
    join public.meetings meeting on meeting.id = commitment.meeting_id
    where commitment.id = commitment_comments.commitment_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
);

create or replace function public.assign_meeting_project(
  p_meeting_id uuid,
  p_project_id uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  meeting_owner uuid;
begin
  select user_id into meeting_owner
  from public.meetings
  where id = p_meeting_id
    and deleted_at is null
  for update;

  if meeting_owner is null then
    raise exception 'Meeting does not exist' using errcode = 'P0002';
  end if;

  if p_project_id is not null and not exists (
    select 1 from public.projects
    where id = p_project_id and owner_id = meeting_owner
  ) then
    raise exception 'Project does not belong to meeting owner'
      using errcode = '42501';
  end if;

  update public.meetings set project_id = p_project_id where id = p_meeting_id;
  update public.meeting_commitments
    set project_id = p_project_id
    where meeting_id = p_meeting_id;
  update public.meeting_tasks
    set project_id = p_project_id
    where meeting_id = p_meeting_id;
end;
$$;

comment on function public.assign_meeting_project(uuid, uuid) is
  'Server-only atomic manual project assignment for a meeting and its execution graph.';

revoke all on function public.assign_meeting_project(uuid, uuid) from public;
revoke all on function public.assign_meeting_project(uuid, uuid) from anon;
revoke all on function public.assign_meeting_project(uuid, uuid) from authenticated;
grant execute on function public.assign_meeting_project(uuid, uuid) to service_role;

create or replace function public.merge_commitment_tasks(
  p_commitment_id uuid,
  p_survivor_task_id uuid,
  p_merged_task_ids uuid[]
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  source_id uuid;
begin
  if p_survivor_task_id = any(coalesce(p_merged_task_ids, '{}'::uuid[])) then
    raise exception 'Survivor cannot be in merged task ids' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.meeting_tasks
    where id = p_survivor_task_id and commitment_id = p_commitment_id
  ) then
    raise exception 'Survivor task does not belong to commitment' using errcode = '22023';
  end if;

  foreach source_id in array coalesce(p_merged_task_ids, '{}'::uuid[])
  loop
    if not exists (
      select 1 from public.meeting_tasks
      where id = source_id and commitment_id = p_commitment_id
    ) then
      raise exception 'Merged task does not belong to commitment' using errcode = '22023';
    end if;

    update public.task_artifacts set task_id = p_survivor_task_id where task_id = source_id;
    update public.task_comments set task_id = p_survivor_task_id where task_id = source_id;

    insert into public.task_dependencies (task_id, depends_on_task_id)
    select rewritten.task_id, rewritten.depends_on_task_id
    from (
      select
        case when dependency.task_id = source_id
          then p_survivor_task_id else dependency.task_id end as task_id,
        case when dependency.depends_on_task_id = source_id
          then p_survivor_task_id else dependency.depends_on_task_id end
          as depends_on_task_id
      from public.task_dependencies dependency
      where dependency.task_id = source_id
         or dependency.depends_on_task_id = source_id
    ) rewritten
    where rewritten.task_id <> rewritten.depends_on_task_id
    on conflict do nothing;

    delete from public.task_dependencies
    where task_id = source_id
       or depends_on_task_id = source_id
       or task_id = depends_on_task_id;

    delete from public.meeting_tasks where id = source_id;
  end loop;

  update public.meeting_tasks
  set preserve_on_reanalysis = true,
      extraction_metadata = extraction_metadata || jsonb_build_object(
        'manually_merged_task_ids', coalesce(p_merged_task_ids, '{}'::uuid[])
      )
  where id = p_survivor_task_id;

  return p_survivor_task_id;
end;
$$;

comment on function public.merge_commitment_tasks(uuid, uuid, uuid[]) is
  'Server-only task merge preserving artifacts, comments, and dependency edges.';

revoke all on function public.merge_commitment_tasks(uuid, uuid, uuid[]) from public;
revoke all on function public.merge_commitment_tasks(uuid, uuid, uuid[]) from anon;
revoke all on function public.merge_commitment_tasks(uuid, uuid, uuid[]) from authenticated;
grant execute on function public.merge_commitment_tasks(uuid, uuid, uuid[]) to service_role;

comment on column public.meetings.project_id is
  'Manually assigned project; automatic meeting linking is intentionally deferred.';
comment on column public.meeting_commitments.project_id is
  'Denormalized from the source meeting for project milestone queries.';
comment on column public.meeting_tasks.project_id is
  'Denormalized from the source meeting for project task queries.';
