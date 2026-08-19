-- Forward-only Production launch alignment.
--
-- This migration is derived from the verified legacy Production catalog and the
-- current application contract. It intentionally does not replay migration
-- history and does not create or repair migration bookkeeping.
--
-- Legacy advanced speaker-resolution objects and transcript attribution fields
-- are intentionally outside this migration.

do $$
declare
  missing_relation text;
  missing_column text;
  unexpected_relation text;
begin
  select relation_name into missing_relation
  from unnest(array[
    'extracted_insights',
    'generated_prompts',
    'meeting_artifacts',
    'meeting_speaker_aliases',
    'meeting_tasks',
    'meeting_topics',
    'meetings',
    'profiles',
    'task_artifacts',
    'task_comments',
    'transcript_segments'
  ]) as expected_legacy(relation_name)
  where not exists (
    select 1
    from pg_class relation_row
    join pg_namespace namespace_row on namespace_row.oid = relation_row.relnamespace
    where namespace_row.nspname = 'public'
      and relation_row.relname = relation_name
      and relation_row.relkind in ('r', 'p')
  )
  limit 1;

  if missing_relation is not null then
    raise exception
      'Production alignment precondition failed: required legacy table public.% is missing',
      missing_relation;
  end if;

  if not exists (
    select 1
    from pg_type type_row
    join pg_namespace namespace_row on namespace_row.oid = type_row.typnamespace
    where namespace_row.nspname = 'public'
      and type_row.typname = 'meeting_status'
      and type_row.typtype = 'e'
  ) then
    raise exception
      'Production alignment precondition failed: public.meeting_status enum is missing';
  end if;

  if exists (
    select 1
    from pg_enum enum_row
    join pg_type type_row on type_row.oid = enum_row.enumtypid
    join pg_namespace namespace_row on namespace_row.oid = type_row.typnamespace
    where namespace_row.nspname = 'public'
      and type_row.typname = 'meeting_status'
      and enum_row.enumlabel = 'transcript_ready'
  ) then
    raise exception
      'Production alignment precondition failed: public.meeting_status already contains transcript_ready';
  end if;

  select column_name into missing_column
  from unnest(array[
    'id',
    'meeting_id',
    'topic_id',
    'task',
    'owner',
    'task_type',
    'priority',
    'suggested_steps',
    'source_quote',
    'confidence',
    'status',
    'created_at',
    'workspace_type',
    'workspace_summary',
    'due_date',
    'rationale',
    'supporting_context',
    'categorization_metadata'
  ]) as expected_legacy_column(column_name)
  where not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'meeting_tasks'
      and column_row.column_name = expected_legacy_column.column_name
  )
  limit 1;

  if missing_column is not null then
    raise exception
      'Production alignment precondition failed: required legacy meeting_tasks.% column is missing',
      missing_column;
  end if;

  if not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'meeting_tasks'
      and column_row.column_name = 'topic_id'
      and column_row.udt_name = 'uuid'
      and column_row.is_nullable = 'NO'
  ) then
    raise exception
      'Production alignment precondition failed: meeting_tasks.topic_id is not legacy UUID NOT NULL';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.meeting_tasks'::regclass
      and constraint_row.conname = 'meeting_tasks_topic_id_fkey'
      and constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.meeting_topics'::regclass
      and constraint_row.confdeltype = 'c'
      and constraint_row.conkey = array[
        (
          select attribute_row.attnum
          from pg_attribute attribute_row
          where attribute_row.attrelid = 'public.meeting_tasks'::regclass
            and attribute_row.attname = 'topic_id'
            and not attribute_row.attisdropped
        )
      ]::smallint[]
      and constraint_row.confkey = array[
        (
          select attribute_row.attnum
          from pg_attribute attribute_row
          where attribute_row.attrelid = 'public.meeting_topics'::regclass
            and attribute_row.attname = 'id'
            and not attribute_row.attisdropped
        )
      ]::smallint[]
  ) then
    raise exception
      'Production alignment precondition failed: meeting_tasks_topic_id_fkey does not match the legacy cascading topic FK';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.meeting_tasks'::regclass
      and constraint_row.conname = 'meeting_tasks_status_check'
      and constraint_row.contype = 'c'
  ) then
    raise exception
      'Production alignment precondition failed: meeting_tasks_status_check is missing';
  end if;

  if not exists (
    select 1
    from pg_index index_row
    join pg_class index_relation on index_relation.oid = index_row.indexrelid
    join pg_namespace namespace_row on namespace_row.oid = index_relation.relnamespace
    where namespace_row.nspname = 'public'
      and index_relation.relname = 'meeting_tasks_dedupe_idx'
      and index_row.indrelid = 'public.meeting_tasks'::regclass
      and index_row.indisunique
      and index_row.indisvalid
      and index_row.indisready
  ) then
    raise exception
      'Production alignment precondition failed: unique meeting_tasks_dedupe_idx is missing or invalid';
  end if;

  select relation_name into unexpected_relation
  from unnest(array[
    'account_verification_events',
    'user_integrations',
    'projects',
    'meeting_commitments',
    'meeting_analysis_jobs',
    'meeting_conversation_events',
    'task_dependencies',
    'commitment_participants',
    'commitment_comments',
    'meeting_comments',
    'project_memory',
    'project_requirements',
    'project_decisions',
    'project_constraints',
    'project_participants',
    'project_chat_threads',
    'project_chat_messages',
    'project_change_proposals',
    'project_change_events'
  ]) as expected_absent(relation_name)
  where to_regclass('public.' || relation_name) is not null
  limit 1;

  if unexpected_relation is not null then
    raise exception
      'Production alignment precondition failed: public.% already exists',
      unexpected_relation;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and (
        (table_name = 'profiles' and column_name = 'avatar_url')
        or (table_name = 'meetings' and column_name in (
          'project_id', 'execution_graph_generation',
          'last_persisted_execution_generation'
        ))
        or (table_name = 'meeting_tasks' and column_name in (
          'commitment_id', 'owners', 'due_date_text', 'source_segment_ids',
          'inferred', 'extraction_metadata', 'preserve_on_reanalysis',
          'manual_override_fields', 'execution_classification', 'project_id',
          'position', 'conversation_event_ids'
        ))
        or (table_name = 'task_artifacts' and column_name in (
          'accepted_at', 'accepted_by'
        ))
      )
  ) then
    raise exception
      'Production alignment precondition failed: an alignment column already exists';
  end if;

  if exists (
    select 1
    from pg_type type_row
    join pg_namespace namespace_row on namespace_row.oid = type_row.typnamespace
    where namespace_row.nspname = 'public'
      and type_row.typname = 'execution_classification'
  ) then
    raise exception
      'Production alignment precondition failed: execution_classification already exists';
  end if;
end;
$$;

alter table public.profiles add column avatar_url text;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    nullif(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'), ''),
    nullif(new.raw_user_meta_data->>'avatar_url', '')
  )
  on conflict (id) do update
  set
    full_name = coalesce(public.profiles.full_name, excluded.full_name),
    avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url);

  return new;
end;
$$;


alter type public.meeting_status add value 'transcript_ready';

create type public.execution_classification as enum (
  'committed',
  'proposed',
  'requirement',
  'future_consideration'
);


-- Account security audit trail.
create table public.account_verification_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  event_type text not null check (
    event_type in (
      'password_code_requested',
      'password_code_rate_limited',
      'password_change_verified',
      'password_change_failed'
    )
  ),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index account_verification_events_user_created_idx
on public.account_verification_events (user_id, created_at desc);

alter table public.account_verification_events enable row level security;

create policy "account_verification_events_select_own"
on public.account_verification_events
for select
using (auth.uid() = user_id);

-- Per-user external integrations.
create table public.user_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  scope text,
  provider_account_email text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, provider)
);

create index user_integrations_user_id_idx
on public.user_integrations (user_id);

create trigger user_integrations_set_updated_at
before update on public.user_integrations
for each row execute procedure public.set_updated_at();

alter table public.user_integrations enable row level security;

create policy "user_integrations_owner_select"
on public.user_integrations
for select
using (user_id = auth.uid());

create policy "user_integrations_owner_insert"
on public.user_integrations
for insert
with check (user_id = auth.uid());

create policy "user_integrations_owner_update"
on public.user_integrations
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "user_integrations_owner_delete"
on public.user_integrations
for delete
using (user_id = auth.uid());

-- Projects must precede project foreign keys.
-- Additive project-first execution hierarchy.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  description text,
  goal text,
  status text not null default 'planning' check (
    status in ('planning', 'active', 'on_hold', 'completed', 'archived')
  ),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  execution_graph_version bigint not null default 0 check (execution_graph_version >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index projects_owner_status_idx
on public.projects (owner_id, status);

create trigger projects_set_updated_at
before update on public.projects
for each row execute procedure public.set_updated_at();

alter table public.projects enable row level security;

create policy "projects_owner_all"
on public.projects
for all
using (owner_id = auth.uid())
with check (owner_id = auth.uid());


alter table public.meetings
  add column project_id uuid references public.projects (id) on delete set null,
  add column execution_graph_generation bigint not null default 0,
  add column last_persisted_execution_generation bigint not null default 0;

create index meetings_project_id_idx on public.meetings (project_id);


-- Commitments are created directly in their final launch shape.
create table public.meeting_commitments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  topic_id uuid references public.meeting_topics (id) on delete set null,
  title text not null check (length(trim(title)) > 0),
  description text,
  owner text,
  owners jsonb not null default '[]'::jsonb,
  due_date date,
  due_date_text text,
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  status text not null default 'pending' check (
    status in ('pending', 'in_progress', 'completed', 'dismissed', 'blocked')
  ),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source_quote text,
  source_segment_ids jsonb not null default '[]'::jsonb,
  type text not null check (
    type in (
      'personal',
      'assignment',
      'implicit',
      'unassigned',
      'reminder',
      'conditional',
      'recurring',
      'group',
      'team',
      'company'
    )
  ),
  completion_state text not null default 'open' check (
    completion_state in ('open', 'in_progress', 'blocked', 'completed', 'cancelled')
  ),
  metadata jsonb not null default '{}'::jsonb,
  preserve_on_reanalysis boolean not null default false,
  manual_override_fields jsonb not null default '[]'::jsonb,
  execution_classification public.execution_classification not null default 'committed',
  project_id uuid references public.projects (id) on delete set null,
  converted_to_task_id uuid references public.meeting_tasks (id) on delete set null,
  lead_owner_id uuid references auth.users (id) on delete set null,
  lead_owner_name text,
  conversation_event_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index meeting_commitments_meeting_id_idx
on public.meeting_commitments (meeting_id);

create index meeting_commitments_topic_id_idx
on public.meeting_commitments (topic_id);

create index meeting_commitments_status_idx
on public.meeting_commitments (status);

create index meeting_commitments_lookup_idx
on public.meeting_commitments (meeting_id, lower(title));

create index meeting_commitments_project_status_idx
on public.meeting_commitments (project_id, status);

create index meeting_commitments_active_project_idx
on public.meeting_commitments (project_id, converted_to_task_id);

create index meeting_commitments_meeting_classification_idx
on public.meeting_commitments (meeting_id, execution_classification);

alter table public.meeting_commitments enable row level security;

create policy "meeting_commitments_owner_all"
on public.meeting_commitments
for all
using (
  exists (
    select 1 from public.meetings m
    where m.id = meeting_commitments.meeting_id
      and m.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.meetings m
    where m.id = meeting_commitments.meeting_id
      and m.user_id = auth.uid()
  )
);

create trigger meeting_commitments_set_updated_at
before update on public.meeting_commitments
for each row execute procedure public.set_updated_at();


alter table public.meeting_tasks
  add column commitment_id uuid references public.meeting_commitments (id) on delete set null,
  add column owners jsonb not null default '[]'::jsonb,
  add column due_date_text text,
  add column source_segment_ids jsonb not null default '[]'::jsonb,
  add column inferred boolean not null default false,
  add column extraction_metadata jsonb not null default '{}'::jsonb,
  add column preserve_on_reanalysis boolean not null default false,
  add column manual_override_fields jsonb not null default '[]'::jsonb,
  add column execution_classification public.execution_classification not null default 'committed',
  add column project_id uuid references public.projects (id) on delete set null,
  add column position integer not null default 0 check (position >= 0),
  add column conversation_event_ids jsonb not null default '[]'::jsonb;

alter table public.meeting_tasks alter column topic_id drop not null;
alter table public.meeting_tasks drop constraint meeting_tasks_topic_id_fkey;
alter table public.meeting_tasks
  add constraint meeting_tasks_topic_id_fkey
  foreign key (topic_id) references public.meeting_topics (id) on delete set null;

alter table public.meeting_tasks drop constraint meeting_tasks_status_check;
alter table public.meeting_tasks
  add constraint meeting_tasks_status_check
  check (status in ('pending', 'in_progress', 'completed', 'dismissed', 'blocked'));

drop index public.meeting_tasks_dedupe_idx;

create index meeting_tasks_lookup_idx
  on public.meeting_tasks (meeting_id, lower(task));
create index meeting_tasks_commitment_id_idx
  on public.meeting_tasks (commitment_id);
create index meeting_tasks_meeting_classification_idx
  on public.meeting_tasks (meeting_id, execution_classification);
create index meeting_tasks_commitment_status_idx
  on public.meeting_tasks (meeting_id, commitment_id, status);
create index meeting_tasks_project_commitment_position_idx
  on public.meeting_tasks (project_id, commitment_id, position);

-- The only explicit legacy task data backfill. Only fields that existed in the
-- verified Production schema are marked as possible historical user edits.
update public.meeting_tasks
set preserve_on_reanalysis = true,
    manual_override_fields = '["status","owner","due_date"]'::jsonb;


alter table public.task_artifacts
  add column accepted_at timestamptz,
  add column accepted_by uuid references auth.users (id) on delete set null;

create index task_artifacts_task_deliverable_version_idx
  on public.task_artifacts (task_id, deliverable_type, version desc);


-- Background analysis jobs, including the final checkpoint field.
create table public.meeting_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  generation bigint not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'stale')),
  current_stage text not null default 'queued',
  progress integer not null default 0 check (progress between 0 and 100),
  error text,
  retry_count integer not null default 0 check (retry_count >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  checkpoint jsonb not null default '{}'::jsonb,
  unique (meeting_id, generation)
);

create index meeting_analysis_jobs_latest_idx
on public.meeting_analysis_jobs (meeting_id, generation desc);

create trigger meeting_analysis_jobs_set_updated_at
before update on public.meeting_analysis_jobs
for each row execute procedure public.set_updated_at();

alter table public.meeting_analysis_jobs enable row level security;

create policy "Users can view own meeting analysis jobs"
on public.meeting_analysis_jobs
for select
using (
  exists (
    select 1
    from public.meetings
    where meetings.id = meeting_analysis_jobs.meeting_id
      and meetings.user_id = auth.uid()
      and meetings.deleted_at is null
  )
);

create or replace function public.claim_meeting_analysis_job(
  p_meeting_id uuid
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  claimed_generation bigint;
  claimed_job_id uuid;
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

  update public.meeting_analysis_jobs
  set status = 'stale',
      current_stage = 'stale',
      error = 'Superseded by a newer analysis generation.',
      completed_at = now()
  where meeting_id = p_meeting_id
    and status in ('queued', 'running');

  insert into public.meeting_analysis_jobs (
    meeting_id,
    generation,
    status,
    current_stage,
    progress
  )
  values (
    p_meeting_id,
    claimed_generation,
    'queued',
    'queued',
    0
  )
  returning id into claimed_job_id;

  return jsonb_build_object(
    'job_id', claimed_job_id,
    'generation', claimed_generation
  );
end;
$$;

comment on function public.claim_meeting_analysis_job(uuid) is
  'Atomically claims the next analysis generation, stales older active jobs, and creates its queued job.';

revoke all on function public.claim_meeting_analysis_job(uuid) from public;
revoke all on function public.claim_meeting_analysis_job(uuid) from anon;
revoke all on function public.claim_meeting_analysis_job(uuid) from authenticated;
grant execute on function public.claim_meeting_analysis_job(uuid) to service_role;

-- Project hierarchy helpers, dependencies, comments, and RPCs.
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

create trigger meeting_commitments_sync_project
before insert or update of meeting_id, project_id on public.meeting_commitments
for each row execute procedure public.sync_execution_row_project();

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

create trigger meeting_tasks_preserve_converted_commitment
after insert or update of extraction_metadata on public.meeting_tasks
for each row execute procedure public.preserve_converted_commitment();

create table public.task_dependencies (
  task_id uuid not null references public.meeting_tasks (id) on delete cascade,
  depends_on_task_id uuid not null references public.meeting_tasks (id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);

create index task_dependencies_prerequisite_idx
on public.task_dependencies (depends_on_task_id);

alter table public.task_dependencies enable row level security;

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

create table public.commitment_comments (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null references public.meeting_commitments (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'system')),
  message text not null check (length(trim(message)) > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index commitment_comments_commitment_created_idx
on public.commitment_comments (commitment_id, created_at);

alter table public.commitment_comments enable row level security;

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

-- Commitment lead-owner synchronization and explicit participants.
create or replace function public.sync_commitment_lead_owner()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.lead_owner_name := coalesce(new.lead_owner_name, new.owner);
  elsif new.owner is distinct from old.owner
    and not coalesce(new.manual_override_fields, '[]'::jsonb) @> '["lead_owner_name"]'::jsonb
  then
    new.lead_owner_name := new.owner;
  end if;
  return new;
end;
$$;

create trigger meeting_commitments_sync_lead_owner
before insert or update of owner on public.meeting_commitments
for each row execute procedure public.sync_commitment_lead_owner();

create table public.commitment_participants (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null
    references public.meeting_commitments (id) on delete cascade,
  participant_user_id uuid references auth.users (id) on delete set null,
  participant_name text not null check (length(trim(participant_name)) > 0),
  involvement_role text not null default 'participant'
    check (involvement_role in ('participant', 'reviewer', 'approver', 'input_provider')),
  manually_added boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (commitment_id, participant_name)
);

create index commitment_participants_commitment_idx
on public.commitment_participants (commitment_id, created_at);

create trigger commitment_participants_set_updated_at
before update on public.commitment_participants
for each row execute procedure public.set_updated_at();

alter table public.commitment_participants enable row level security;

create policy "commitment_participants_owner_all"
on public.commitment_participants
for all
using (
  exists (
    select 1
    from public.meeting_commitments commitment
    join public.meetings meeting on meeting.id = commitment.meeting_id
    where commitment.id = commitment_participants.commitment_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
)
with check (
  exists (
    select 1
    from public.meeting_commitments commitment
    join public.meetings meeting on meeting.id = commitment.meeting_id
    where commitment.id = commitment_participants.commitment_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
);

comment on table public.commitment_participants is
  'Explicit commitment participants. Rows are independent from graph replacement, so manual additions survive re-analysis while task owners are derived at read time.';

-- Project Brain durable context and final base proposal RPC.
create table public.project_memory (
  project_id uuid primary key references public.projects (id) on delete cascade,
  summary text,
  goal text,
  product_description text,
  target_audience text,
  current_scope jsonb not null default '[]'::jsonb,
  future_scope jsonb not null default '[]'::jsonb,
  technical_context jsonb not null default '{}'::jsonb,
  design_context jsonb not null default '{}'::jsonb,
  constraints jsonb not null default '[]'::jsonb,
  assumptions jsonb not null default '[]'::jsonb,
  success_criteria jsonb not null default '[]'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  confirmed_fields jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.project_requirements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  description text,
  category text not null default 'general',
  status text not null default 'active'
    check (status in ('active', 'satisfied', 'deferred', 'archived')),
  source_type text not null
    check (source_type in ('meeting', 'project_chat', 'manual', 'integration')),
  source_id uuid,
  manually_confirmed boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index project_requirements_title_idx
on public.project_requirements (project_id, lower(title));

create table public.project_decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  description text,
  status text not null default 'active'
    check (status in ('active', 'superseded', 'reversed', 'archived')),
  decided_at timestamptz,
  source_type text not null
    check (source_type in ('meeting', 'project_chat', 'manual', 'integration')),
  source_id uuid,
  supersedes_decision_id uuid references public.project_decisions (id) on delete set null,
  manually_confirmed boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index project_decisions_title_idx
on public.project_decisions (project_id, lower(title));

create table public.project_constraints (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  description text,
  category text not null default 'general',
  status text not null default 'active'
    check (status in ('active', 'resolved', 'removed', 'archived')),
  source_type text not null
    check (source_type in ('meeting', 'project_chat', 'manual', 'integration')),
  source_id uuid,
  manually_confirmed boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index project_constraints_title_idx
on public.project_constraints (project_id, lower(title));

create table public.project_participants (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  participant_user_id uuid references auth.users (id) on delete set null,
  participant_name text not null check (length(trim(participant_name)) > 0),
  role text not null default 'participant',
  source_type text not null
    check (source_type in ('meeting', 'project_chat', 'manual', 'integration')),
  source_id uuid,
  manually_confirmed boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (project_id, participant_name)
);

create table public.project_chat_threads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null default 'Project Brain',
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index project_chat_threads_project_updated_idx
on public.project_chat_threads (project_id, updated_at desc);

create table public.project_chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.project_chat_threads (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null check (length(trim(content)) > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create index project_chat_messages_thread_created_idx
on public.project_chat_messages (thread_id, created_at);

create table public.project_change_proposals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  thread_id uuid references public.project_chat_threads (id) on delete set null,
  source_message_id uuid references public.project_chat_messages (id) on delete set null,
  status text not null default 'draft' check (
    status in (
      'draft', 'pending_review', 'approved', 'applied', 'rejected',
      'failed', 'superseded'
    )
  ),
  summary text not null,
  proposal jsonb not null default '{"operations":[]}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  base_graph_version bigint not null check (base_graph_version >= 0),
  resulting_graph_version bigint check (resulting_graph_version >= 0),
  created_by uuid not null references auth.users (id) on delete cascade,
  approved_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  applied_at timestamptz,
  rejected_at timestamptz
);

create index project_change_proposals_project_created_idx
on public.project_change_proposals (project_id, created_at desc);

create table public.project_change_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  proposal_id uuid references public.project_change_proposals (id) on delete set null,
  actor_type text not null check (actor_type in ('user', 'assistant', 'system', 'integration')),
  actor_id uuid references auth.users (id) on delete set null,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  before_state jsonb,
  after_state jsonb,
  source_type text not null
    check (source_type in ('meeting', 'project_chat', 'manual', 'integration')),
  source_id uuid,
  created_at timestamptz not null default timezone('utc', now())
);

create index project_change_events_project_created_idx
on public.project_change_events (project_id, created_at desc);

create trigger project_memory_set_updated_at before update on public.project_memory
for each row execute procedure public.set_updated_at();
create trigger project_requirements_set_updated_at before update on public.project_requirements
for each row execute procedure public.set_updated_at();
create trigger project_decisions_set_updated_at before update on public.project_decisions
for each row execute procedure public.set_updated_at();
create trigger project_constraints_set_updated_at before update on public.project_constraints
for each row execute procedure public.set_updated_at();
create trigger project_participants_set_updated_at before update on public.project_participants
for each row execute procedure public.set_updated_at();
create trigger project_chat_threads_set_updated_at before update on public.project_chat_threads
for each row execute procedure public.set_updated_at();

create or replace function public.can_access_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects
    where id = p_project_id and owner_id = auth.uid()
  );
$$;

revoke all on function public.can_access_project(uuid) from public;
grant execute on function public.can_access_project(uuid) to authenticated, service_role;

alter table public.project_memory enable row level security;
alter table public.project_requirements enable row level security;
alter table public.project_decisions enable row level security;
alter table public.project_constraints enable row level security;
alter table public.project_participants enable row level security;
alter table public.project_chat_threads enable row level security;
alter table public.project_chat_messages enable row level security;
alter table public.project_change_proposals enable row level security;
alter table public.project_change_events enable row level security;

create policy "project_memory_owner_all" on public.project_memory for all
using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));
create policy "project_requirements_owner_all" on public.project_requirements for all
using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));
create policy "project_decisions_owner_all" on public.project_decisions for all
using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));
create policy "project_constraints_owner_all" on public.project_constraints for all
using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));
create policy "project_participants_owner_all" on public.project_participants for all
using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));
create policy "project_chat_threads_owner_all" on public.project_chat_threads for all
using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));
create policy "project_chat_messages_owner_select"
on public.project_chat_messages for select
using (public.can_access_project(project_id));
create policy "project_chat_messages_user_insert"
on public.project_chat_messages for insert
with check (
  public.can_access_project(project_id)
  and role = 'user'
  and created_by = auth.uid()
  and exists (
    select 1 from public.project_chat_threads thread
    where thread.id = project_chat_messages.thread_id
      and thread.project_id = project_chat_messages.project_id
      and thread.created_by = auth.uid()
  )
);
create policy "project_change_proposals_owner_select"
on public.project_change_proposals for select
using (public.can_access_project(project_id));
create policy "project_change_events_owner_select" on public.project_change_events for select
using (public.can_access_project(project_id));

-- Re-analysis currently recalculates task parents. Preserve an explicitly reviewed
-- Project Brain move unless another explicit mutation also extends the override list.
create or replace function public.preserve_manual_task_parent()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.manual_override_fields ? 'commitment_id'
    and new.commitment_id is distinct from old.commitment_id
    and new.manual_override_fields = old.manual_override_fields
  then
    new.commitment_id := old.commitment_id;
  end if;
  return new;
end;
$$;

create trigger meeting_tasks_preserve_manual_parent
before update of commitment_id on public.meeting_tasks
for each row execute procedure public.preserve_manual_task_parent();

create or replace function public.apply_project_change_proposal(
  p_proposal_id uuid,
  p_actor_id uuid,
  p_operations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  proposal_row public.project_change_proposals%rowtype;
  project_row public.projects%rowtype;
  operation jsonb;
  operation_type text;
  changes jsonb;
  entity_id uuid;
  target_id uuid;
  source_id uuid;
  source_ids uuid[];
  meeting_id uuid;
  before_value jsonb;
  after_value jsonb;
  field_name text;
begin
  select * into proposal_row
  from public.project_change_proposals
  where id = p_proposal_id
  for update;

  if proposal_row.id is null then
    raise exception 'proposal_not_found' using errcode = 'P0002';
  end if;

  select * into project_row
  from public.projects
  where id = proposal_row.project_id
  for update;

  if project_row.owner_id <> p_actor_id then
    raise exception 'project_access_denied' using errcode = '42501';
  end if;

  if proposal_row.status not in ('pending_review', 'approved') then
    raise exception 'proposal_not_applicable' using errcode = '22023';
  end if;

  if project_row.execution_graph_version <> proposal_row.base_graph_version then
    update public.project_change_proposals
    set status = 'superseded'
    where id = proposal_row.id;
    return jsonb_build_object(
      'applied', false,
      'stale', true,
      'currentGraphVersion', project_row.execution_graph_version
    );
  end if;

  if jsonb_typeof(p_operations) <> 'array'
    or jsonb_array_length(p_operations) > 100
  then
    raise exception 'invalid_operations' using errcode = '22023';
  end if;

  update public.project_change_proposals
  set status = 'approved',
      approved_by = p_actor_id,
      proposal = jsonb_build_object('operations', p_operations)
  where id = proposal_row.id;

  for operation in
    select value from jsonb_array_elements(p_operations)
  loop
    operation_type := operation->>'type';
    changes := coalesce(operation->'changes', '{}'::jsonb);
    entity_id := null;
    before_value := null;
    after_value := null;

    if operation_type = 'update_project' then
      before_value := to_jsonb(project_row);
      update public.projects
      set name = case when changes ? 'name' then changes->>'name' else name end,
          description = case when changes ? 'description' then changes->>'description' else description end,
          goal = case when changes ? 'goal' then changes->>'goal' else goal end,
          status = case when changes ? 'status' then changes->>'status' else status end
      where id = project_row.id
      returning id, to_jsonb(public.projects.*) into entity_id, after_value;

    elsif operation_type = 'update_project_memory' then
      select to_jsonb(memory.*) into before_value
      from public.project_memory memory
      where memory.project_id = project_row.id;

      insert into public.project_memory (
        project_id, summary, goal, product_description, target_audience,
        current_scope, future_scope, technical_context, design_context,
        constraints, assumptions, success_criteria, provenance,
        confirmed_fields, updated_by
      )
      values (
        project_row.id,
        changes->>'summary',
        changes->>'goal',
        changes->>'product_description',
        changes->>'target_audience',
        coalesce(changes->'current_scope', '[]'::jsonb),
        coalesce(changes->'future_scope', '[]'::jsonb),
        coalesce(changes->'technical_context', '{}'::jsonb),
        coalesce(changes->'design_context', '{}'::jsonb),
        coalesce(changes->'constraints', '[]'::jsonb),
        coalesce(changes->'assumptions', '[]'::jsonb),
        coalesce(changes->'success_criteria', '[]'::jsonb),
        (
          select coalesce(jsonb_object_agg(key, jsonb_build_object(
            'source_type', 'project_chat',
            'source_id', proposal_row.source_message_id,
            'confirmed', true,
            'updated_at', timezone('utc', now())
          )), '{}'::jsonb)
          from jsonb_object_keys(changes) key
        ),
        (
          select coalesce(jsonb_object_agg(key, true), '{}'::jsonb)
          from jsonb_object_keys(changes) key
        ),
        p_actor_id
      )
      on conflict (project_id) do update
      set summary = case when changes ? 'summary' then changes->>'summary' else project_memory.summary end,
          goal = case when changes ? 'goal' then changes->>'goal' else project_memory.goal end,
          product_description = case when changes ? 'product_description' then changes->>'product_description' else project_memory.product_description end,
          target_audience = case when changes ? 'target_audience' then changes->>'target_audience' else project_memory.target_audience end,
          current_scope = case when changes ? 'current_scope' then changes->'current_scope' else project_memory.current_scope end,
          future_scope = case when changes ? 'future_scope' then changes->'future_scope' else project_memory.future_scope end,
          technical_context = case when changes ? 'technical_context' then changes->'technical_context' else project_memory.technical_context end,
          design_context = case when changes ? 'design_context' then changes->'design_context' else project_memory.design_context end,
          constraints = case when changes ? 'constraints' then changes->'constraints' else project_memory.constraints end,
          assumptions = case when changes ? 'assumptions' then changes->'assumptions' else project_memory.assumptions end,
          success_criteria = case when changes ? 'success_criteria' then changes->'success_criteria' else project_memory.success_criteria end,
          provenance = project_memory.provenance || excluded.provenance,
          confirmed_fields = project_memory.confirmed_fields || excluded.confirmed_fields,
          updated_by = p_actor_id
      returning project_id, to_jsonb(public.project_memory.*)
      into entity_id, after_value;
      if changes ? 'goal' or changes ? 'summary' then
        update public.projects
        set goal = case when changes ? 'goal' then changes->>'goal' else goal end,
            description = case
              when changes ? 'summary' then changes->>'summary'
              else description
            end
        where id = project_row.id;
      end if;

    elsif operation_type = 'create_milestone' then
      select id into meeting_id from public.meetings
      where project_id = project_row.id and deleted_at is null
      order by created_at desc limit 1;
      if meeting_id is null then
        raise exception 'project_has_no_meeting_for_milestone' using errcode = '22023';
      end if;
      insert into public.meeting_commitments (
        meeting_id, project_id, title, description, owner, owners, priority,
        status, confidence, source_quote, source_segment_ids, type,
        completion_state, execution_classification, metadata,
        preserve_on_reanalysis, manual_override_fields
      ) values (
        meeting_id, project_row.id, operation->>'title',
        nullif(operation->>'description', ''), nullif(operation->>'owner', ''),
        coalesce(operation->'owners', '[]'::jsonb),
        coalesce(operation->>'priority', 'medium'), 'pending', 1,
        'Created from approved Project Brain proposal', '[]'::jsonb,
        'unassigned', 'open', 'committed',
        jsonb_build_object('source_type', 'project_chat', 'proposal_id', proposal_row.id),
        true, '["title","description","owner","owners","priority"]'::jsonb
      )
      returning id, to_jsonb(public.meeting_commitments.*)
      into entity_id, after_value;

    elsif operation_type in ('update_milestone', 'archive_milestone') then
      entity_id := (operation->>'milestoneId')::uuid;
      select to_jsonb(commitment.*) into before_value
      from public.meeting_commitments commitment
      where commitment.id = entity_id and commitment.project_id = project_row.id
      for update;
      if before_value is null then
        raise exception 'milestone_outside_project' using errcode = '42501';
      end if;
      update public.meeting_commitments
      set title = case when changes ? 'title' then changes->>'title' else title end,
          description = case when changes ? 'description' then changes->>'description' else description end,
          owner = case when changes ? 'owner' then changes->>'owner' else owner end,
          due_date = case when changes ? 'due_date' then (changes->>'due_date')::date else due_date end,
          priority = case when changes ? 'priority' then changes->>'priority' else priority end,
          status = case
            when operation_type = 'archive_milestone' then 'dismissed'
            when changes ? 'status' then changes->>'status' else status end,
          completion_state = case
            when operation_type = 'archive_milestone' then 'cancelled'
            when changes ? 'completion_state' then changes->>'completion_state'
            else completion_state end,
          execution_classification = case
            when operation_type = 'archive_milestone'
              then 'future_consideration'
            else execution_classification end,
          preserve_on_reanalysis = true,
          manual_override_fields = coalesce(manual_override_fields, '[]'::jsonb)
            || coalesce(to_jsonb(array(select jsonb_object_keys(changes))), '[]'::jsonb)
            || case
              when operation_type = 'archive_milestone'
                then '["status","completion_state","execution_classification"]'::jsonb
              else '[]'::jsonb
            end
      where id = entity_id
      returning to_jsonb(public.meeting_commitments.*) into after_value;

    elsif operation_type = 'merge_milestones' then
      source_ids := array(
        select value::text::uuid
        from jsonb_array_elements_text(operation->'sourceMilestoneIds') value
      );
      target_id := nullif(operation->>'targetMilestoneId', '')::uuid;
      if target_id is null then
        target_id := source_ids[1];
      end if;
      if not exists (
        select 1 from public.meeting_commitments
        where id = target_id and project_id = project_row.id
      ) or exists (
        select 1 from unnest(source_ids) source
        left join public.meeting_commitments commitment on commitment.id = source
        where commitment.project_id is distinct from project_row.id
      ) then
        raise exception 'milestone_outside_project' using errcode = '42501';
      end if;
      if exists (
        select 1
        from unnest(source_ids) source
        join public.meeting_commitments source_commitment
          on source_commitment.id = source
        join public.meeting_commitments target_commitment
          on target_commitment.id = target_id
        where source_commitment.meeting_id <> target_commitment.meeting_id
      ) then
        raise exception 'cross_meeting_milestone_merge_not_supported'
          using errcode = '22023';
      end if;
      select to_jsonb(commitment.*) into before_value
      from public.meeting_commitments commitment where id = target_id for update;
      update public.meeting_commitments
      set title = coalesce(operation->'target'->>'title', title),
          description = coalesce(operation->'target'->>'description', description),
          preserve_on_reanalysis = true
      where id = target_id;
      update public.meeting_tasks
      set commitment_id = target_id,
          preserve_on_reanalysis = true,
          manual_override_fields = coalesce(manual_override_fields, '[]'::jsonb)
            || '["commitment_id"]'::jsonb
      where commitment_id = any(source_ids) and commitment_id <> target_id;
      update public.commitment_comments set commitment_id = target_id
      where commitment_id = any(source_ids) and commitment_id <> target_id;
      insert into public.commitment_participants (
        commitment_id, participant_user_id, participant_name,
        involvement_role, manually_added
      )
      select target_id, participant_user_id, participant_name,
        involvement_role, manually_added
      from public.commitment_participants
      where commitment_id = any(source_ids) and commitment_id <> target_id
      on conflict (commitment_id, participant_name) do nothing;
      delete from public.commitment_participants
      where commitment_id = any(source_ids) and commitment_id <> target_id;
      update public.meeting_commitments
      set status = 'dismissed',
          completion_state = 'cancelled',
          metadata = metadata || jsonb_build_object('merged_into', target_id),
          preserve_on_reanalysis = true,
          manual_override_fields = coalesce(manual_override_fields, '[]'::jsonb)
            || '["status","completion_state"]'::jsonb
      where id = any(source_ids) and id <> target_id;
      entity_id := target_id;
      select to_jsonb(commitment.*) into after_value
      from public.meeting_commitments commitment where id = target_id;

    elsif operation_type = 'create_task' then
      target_id := (operation->>'milestoneId')::uuid;
      select commitment.meeting_id into meeting_id
      from public.meeting_commitments commitment
      where commitment.id = target_id
        and commitment.project_id = project_row.id;
      if meeting_id is null then
        raise exception 'milestone_outside_project' using errcode = '42501';
      end if;
      insert into public.meeting_tasks (
        meeting_id, project_id, commitment_id, task, owner, owners, task_type,
        priority, suggested_steps, source_quote, confidence, status,
        workspace_type, workspace_summary, execution_classification, position,
        preserve_on_reanalysis, manual_override_fields, extraction_metadata
      ) values (
        meeting_id, project_row.id, target_id, operation->>'title',
        nullif(operation->>'ownerName', ''), '[]'::jsonb, 'unassigned_work',
        coalesce(operation->>'priority', 'medium'), '[]'::jsonb,
        'Created from approved Project Brain proposal', 1, 'pending',
        coalesce(operation->>'workspaceType', 'other'),
        nullif(operation->>'description', ''), 'committed',
        coalesce((operation->>'position')::integer, 0), true,
        '["task","owner","priority","status"]'::jsonb,
        jsonb_build_object('source_type', 'project_chat', 'proposal_id', proposal_row.id)
      )
      returning id, to_jsonb(public.meeting_tasks.*) into entity_id, after_value;

    elsif operation_type in (
      'update_task', 'archive_task', 'update_task_status', 'assign_task_owner'
    ) then
      entity_id := (operation->>'taskId')::uuid;
      select to_jsonb(task.*) into before_value
      from public.meeting_tasks task
      where task.id = entity_id and task.project_id = project_row.id
      for update;
      if before_value is null then
        raise exception 'task_outside_project' using errcode = '42501';
      end if;
      update public.meeting_tasks
      set task = case when changes ? 'task' then changes->>'task' else task end,
          workspace_summary = case when changes ? 'description' then changes->>'description' else workspace_summary end,
          owner = case
            when operation_type = 'assign_task_owner' then nullif(operation->>'ownerName', '')
            when changes ? 'owner' then changes->>'owner' else owner end,
          due_date = case when changes ? 'due_date' then (changes->>'due_date')::date else due_date end,
          priority = case when changes ? 'priority' then changes->>'priority' else priority end,
          status = case
            when operation_type = 'archive_task' then 'dismissed'
            when operation_type = 'update_task_status' then operation->>'status'
            when changes ? 'status' then changes->>'status' else status end,
          execution_classification = case
            when operation_type = 'archive_task'
              then 'future_consideration'
            else execution_classification end,
          preserve_on_reanalysis = true,
          manual_override_fields = coalesce(manual_override_fields, '[]'::jsonb)
            || coalesce(to_jsonb(array(
              select case
                when key = 'description' then 'workspace_summary'
                else key
              end
              from jsonb_object_keys(changes) key
            )), '[]'::jsonb)
            || case
              when operation_type = 'archive_task'
                then '["status","execution_classification"]'::jsonb
              when operation_type = 'update_task_status'
                then '["status"]'::jsonb
              when operation_type = 'assign_task_owner'
                then '["owner"]'::jsonb
              else '[]'::jsonb
            end
      where id = entity_id
      returning to_jsonb(public.meeting_tasks.*) into after_value;

    elsif operation_type = 'move_task' then
      entity_id := (operation->>'taskId')::uuid;
      target_id := (operation->>'targetMilestoneId')::uuid;
      select to_jsonb(task.*) into before_value
      from public.meeting_tasks task
      where task.id = entity_id and task.project_id = project_row.id for update;
      if before_value is null or not exists (
        select 1 from public.meeting_commitments
        where id = target_id and project_id = project_row.id
      ) then
        raise exception 'entity_outside_project' using errcode = '42501';
      end if;
      if exists (
        select 1
        from public.task_dependencies dependency
        join public.meeting_tasks related_task
          on related_task.id = case
            when dependency.task_id = entity_id
              then dependency.depends_on_task_id
            else dependency.task_id
          end
        where (
          dependency.task_id = entity_id
          or dependency.depends_on_task_id = entity_id
        )
          and related_task.commitment_id is distinct from target_id
      ) then
        raise exception 'move_task_dependency_conflict'
          using errcode = '22023';
      end if;
      update public.meeting_tasks
      set commitment_id = target_id,
          preserve_on_reanalysis = true,
          manual_override_fields = coalesce(manual_override_fields, '[]'::jsonb)
            || '["commitment_id"]'::jsonb
      where id = entity_id
      returning to_jsonb(public.meeting_tasks.*) into after_value;

    elsif operation_type = 'merge_tasks' then
      target_id := (operation->>'survivorTaskId')::uuid;
      source_ids := array(
        select value::text::uuid
        from jsonb_array_elements_text(operation->'mergedTaskIds') value
      );
      select commitment_id, to_jsonb(task.*) into entity_id, before_value
      from public.meeting_tasks task
      where task.id = target_id and task.project_id = project_row.id for update;
      if entity_id is null or exists (
        select 1 from unnest(source_ids) source
        left join public.meeting_tasks task on task.id = source
        where task.project_id is distinct from project_row.id
      ) then
        raise exception 'task_outside_project' using errcode = '42501';
      end if;
      update public.meeting_tasks
      set commitment_id = entity_id,
          preserve_on_reanalysis = true,
          manual_override_fields = coalesce(manual_override_fields, '[]'::jsonb)
            || '["commitment_id"]'::jsonb
      where id = any(source_ids);
      perform public.merge_commitment_tasks(entity_id, target_id, source_ids);
      entity_id := target_id;
      select to_jsonb(task.*) into after_value
      from public.meeting_tasks task where id = target_id;

    elsif operation_type in ('add_requirement', 'update_requirement') then
      entity_id := nullif(operation->>'requirementId', '')::uuid;
      if entity_id is not null then
        select to_jsonb(requirement.*) into before_value
        from public.project_requirements requirement
        where requirement.id = entity_id and requirement.project_id = project_row.id;
        if before_value is null then raise exception 'requirement_outside_project' using errcode = '42501'; end if;
        update public.project_requirements
        set title = coalesce(operation->>'title', title),
            description = coalesce(operation->>'description', description),
            category = coalesce(operation->>'category', category),
            status = coalesce(operation->>'status', status),
            manually_confirmed = true
        where id = entity_id
        returning to_jsonb(public.project_requirements.*) into after_value;
      else
        insert into public.project_requirements (
          project_id, title, description, category, status,
          source_type, source_id, manually_confirmed
        ) values (
          project_row.id, operation->>'title', operation->>'description',
          coalesce(operation->>'category', 'general'),
          coalesce(operation->>'status', 'active'), 'project_chat',
          proposal_row.source_message_id, true
        )
        returning id, to_jsonb(public.project_requirements.*) into entity_id, after_value;
      end if;

    elsif operation_type in ('add_decision', 'supersede_decision') then
      if operation_type = 'supersede_decision' then
        source_id := (operation->>'decisionId')::uuid;
        update public.project_decisions set status = 'superseded'
        where id = source_id and project_id = project_row.id
        returning to_jsonb(public.project_decisions.*) into before_value;
        if before_value is null then raise exception 'decision_outside_project' using errcode = '42501'; end if;
      end if;
      insert into public.project_decisions (
        project_id, title, description, status, decided_at, source_type,
        source_id, supersedes_decision_id, manually_confirmed
      ) values (
        project_row.id, operation->>'title', operation->>'description',
        'active', timezone('utc', now()), 'project_chat',
        proposal_row.source_message_id,
        case when operation_type = 'supersede_decision' then source_id else null end,
        true
      )
      returning id, to_jsonb(public.project_decisions.*) into entity_id, after_value;

    elsif operation_type in ('add_constraint', 'remove_constraint') then
      if operation_type = 'remove_constraint' then
        entity_id := (operation->>'constraintId')::uuid;
        select to_jsonb(constraint_row.*) into before_value
        from public.project_constraints constraint_row
        where constraint_row.id = entity_id and constraint_row.project_id = project_row.id;
        if before_value is null then raise exception 'constraint_outside_project' using errcode = '42501'; end if;
        update public.project_constraints set status = 'removed'
        where id = entity_id
        returning to_jsonb(public.project_constraints.*) into after_value;
      else
        insert into public.project_constraints (
          project_id, title, description, category, status,
          source_type, source_id, manually_confirmed
        ) values (
          project_row.id, operation->>'title', operation->>'description',
          coalesce(operation->>'category', 'general'), 'active',
          'project_chat', proposal_row.source_message_id, true
        )
        returning id, to_jsonb(public.project_constraints.*) into entity_id, after_value;
      end if;

    elsif operation_type in ('add_dependency', 'remove_dependency') then
      entity_id := (operation->>'taskId')::uuid;
      target_id := (operation->>'dependsOnTaskId')::uuid;
      if not exists (
        select 1 from public.meeting_tasks task
        join public.meeting_tasks dependency on dependency.id = target_id
        where task.id = entity_id
          and task.project_id = project_row.id
          and dependency.project_id = project_row.id
          and dependency.commitment_id is not distinct from task.commitment_id
      ) then
        raise exception 'dependency_outside_project_or_milestone' using errcode = '42501';
      end if;
      before_value := jsonb_build_object('task_id', entity_id, 'depends_on_task_id', target_id);
      if operation_type = 'add_dependency' then
        insert into public.task_dependencies (task_id, depends_on_task_id)
        values (entity_id, target_id) on conflict do nothing;
        after_value := before_value;
      else
        delete from public.task_dependencies
        where task_id = entity_id and depends_on_task_id = target_id;
        after_value := null;
      end if;

    elsif operation_type = 'add_project_participant' then
      insert into public.project_participants (
        project_id, participant_user_id, participant_name, role,
        source_type, source_id, manually_confirmed
      ) values (
        project_row.id, nullif(operation->>'participantUserId', '')::uuid,
        operation->>'participantName', coalesce(operation->>'role', 'participant'),
        'project_chat', proposal_row.source_message_id, true
      )
      on conflict (project_id, participant_name) do update
      set role = excluded.role, manually_confirmed = true
      returning id, to_jsonb(public.project_participants.*) into entity_id, after_value;

    else
      raise exception 'unsupported_operation:%', operation_type using errcode = '22023';
    end if;

    insert into public.project_change_events (
      project_id, proposal_id, actor_type, actor_id, event_type,
      entity_type, entity_id, before_state, after_state,
      source_type, source_id
    ) values (
      project_row.id, proposal_row.id, 'user', p_actor_id, operation_type,
      replace(operation_type, 'update_', ''), entity_id, before_value,
      after_value, 'project_chat', proposal_row.source_message_id
    );
  end loop;

  update public.projects
  set execution_graph_version = execution_graph_version + 1
  where id = project_row.id
  returning execution_graph_version into project_row.execution_graph_version;

  update public.project_change_proposals
  set status = 'applied',
      approved_by = p_actor_id,
      applied_at = timezone('utc', now()),
      resulting_graph_version = project_row.execution_graph_version
  where id = proposal_row.id;

  insert into public.project_change_events (
    project_id, proposal_id, actor_type, actor_id, event_type,
    entity_type, entity_id, before_state, after_state, source_type, source_id
  ) values (
    project_row.id, proposal_row.id, 'user', p_actor_id,
    'proposal_applied', 'project', project_row.id,
    jsonb_build_object('execution_graph_version', proposal_row.base_graph_version),
    jsonb_build_object('execution_graph_version', project_row.execution_graph_version),
    'project_chat', proposal_row.source_message_id
  );

  return jsonb_build_object(
    'applied', true,
    'stale', false,
    'resultingGraphVersion', project_row.execution_graph_version
  );
end;
$$;

comment on function public.apply_project_change_proposal(uuid, uuid, jsonb) is
  'Service-role-only version-checked atomic Project Brain proposal application with audit events.';

revoke all on function public.apply_project_change_proposal(uuid, uuid, jsonb) from public;
revoke all on function public.apply_project_change_proposal(uuid, uuid, jsonb) from anon;
revoke all on function public.apply_project_change_proposal(uuid, uuid, jsonb) from authenticated;
grant execute on function public.apply_project_change_proposal(uuid, uuid, jsonb) to service_role;

-- Conversation events.
create table public.meeting_conversation_events (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  client_ref text not null,
  type text not null check (type in (
    'promise', 'request', 'acceptance', 'assignment', 'decision',
    'progress_update', 'proposal', 'future_idea', 'question', 'reminder',
    'scheduling_agreement', 'blocker', 'completed_work', 'requirement'
  )),
  actors jsonb not null default '[]'::jsonb,
  action text,
  object text,
  temporal_state text not null check (temporal_state in (
    'past', 'present', 'future', 'conditional', 'recurring', 'unspecified'
  )),
  commitment_signal text not null check (commitment_signal in (
    'none', 'proposed', 'requested', 'accepted', 'explicit'
  )),
  source_quote text not null,
  source_segment_ids jsonb not null default '[]'::jsonb,
  linked_event_refs jsonb not null default '[]'::jsonb,
  confidence numeric,
  analysis_generation bigint not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (meeting_id, client_ref)
);

create index meeting_conversation_events_meeting_type_idx
on public.meeting_conversation_events (meeting_id, type);

alter table public.meeting_conversation_events enable row level security;

create policy "Users can view their meeting conversation events"
on public.meeting_conversation_events for select
using (exists (
  select 1 from public.meetings
  where meetings.id = meeting_conversation_events.meeting_id
    and meetings.user_id = auth.uid()
));

create or replace function public.replace_meeting_conversation_events(
  p_meeting_id uuid,
  p_generation bigint,
  p_events jsonb
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  current_generation bigint;
  event_row jsonb;
  inserted_count integer := 0;
begin
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array' then
    raise exception 'Events must be a JSON array' using errcode = '22023';
  end if;

  select execution_graph_generation into current_generation
  from public.meetings
  where id = p_meeting_id and deleted_at is null
  for update;

  if current_generation is null then
    raise exception 'Meeting does not exist or has been deleted' using errcode = 'P0002';
  end if;
  if current_generation <> p_generation then
    raise exception 'stale_analysis_run' using errcode = 'P0001';
  end if;

  delete from public.meeting_conversation_events where meeting_id = p_meeting_id;
  for event_row in select value from jsonb_array_elements(coalesce(p_events, '[]'::jsonb))
  loop
    insert into public.meeting_conversation_events (
      meeting_id, client_ref, type, actors, action, object, temporal_state,
      commitment_signal, source_quote, source_segment_ids, linked_event_refs,
      confidence, analysis_generation
    ) values (
      p_meeting_id,
      event_row->>'client_ref',
      event_row->>'type',
      coalesce(event_row->'actors', '[]'::jsonb),
      nullif(event_row->>'action', ''),
      nullif(event_row->>'object', ''),
      event_row->>'temporal_state',
      event_row->>'commitment_signal',
      event_row->>'source_quote',
      coalesce(event_row->'source_segment_ids', '[]'::jsonb),
      coalesce(event_row->'linked_event_refs', '[]'::jsonb),
      nullif(event_row->>'confidence', '')::numeric,
      p_generation
    );
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end;
$$;

revoke all on function public.replace_meeting_conversation_events(uuid, bigint, jsonb) from public;
revoke all on function public.replace_meeting_conversation_events(uuid, bigint, jsonb) from anon;
revoke all on function public.replace_meeting_conversation_events(uuid, bigint, jsonb) from authenticated;
grant execute on function public.replace_meeting_conversation_events(uuid, bigint, jsonb) to service_role;

-- Manual classification preservation.
-- Phase 6 (trust/correction) gap fix.
--
-- replace_meeting_execution_graph already guards most user-edited columns from being
-- silently overwritten during reanalysis via the `manual_override_fields ? 'field'` case
-- pattern (title, owner, status, due_date, etc.). It does NOT guard execution_classification --
-- that column is unconditionally set to whatever the new analysis run produced. Meeting_tasks
-- already has an equivalent, narrower protection for commitment_id via the
-- preserve_manual_task_parent trigger (see 20260727130000_project_brain_phase1.sql). This
-- migration applies the identical, already-established pattern to execution_classification on
-- both meeting_tasks and meeting_commitments, so a user's manual "Move to Future Scope" /
-- "Promote to active work" correction survives the next reanalysis the same way a manual
-- commitment_id move already does.
--
-- The trigger only reverts a change when manual_override_fields itself is untouched by the same
-- UPDATE statement -- a reanalysis run's blind overwrite never also extends
-- manual_override_fields, while a legitimate manual correction (via the API routes added in
-- this phase) always adds 'execution_classification' to manual_override_fields in the same
-- statement, so its own change is never reverted.

create or replace function public.preserve_manual_task_classification()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.manual_override_fields ? 'execution_classification'
    and new.execution_classification is distinct from old.execution_classification
    and new.manual_override_fields = old.manual_override_fields
  then
    new.execution_classification := old.execution_classification;
  end if;
  return new;
end;
$$;

create trigger meeting_tasks_preserve_manual_classification
before update of execution_classification on public.meeting_tasks
for each row execute procedure public.preserve_manual_task_classification();

create or replace function public.preserve_manual_commitment_classification()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.manual_override_fields ? 'execution_classification'
    and new.execution_classification is distinct from old.execution_classification
    and new.manual_override_fields = old.manual_override_fields
  then
    new.execution_classification := old.execution_classification;
  end if;
  return new;
end;
$$;

create trigger meeting_commitments_preserve_manual_classification
before update of execution_classification on public.meeting_commitments
for each row execute procedure public.preserve_manual_commitment_classification();

-- Final generation-locked, classification-aware graph replacement.
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
  next_classification public.execution_classification;
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

  if current_generation <> p_generation
     or persisted_generation >= p_generation then
    raise exception 'stale_analysis_run'
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
    next_classification := coalesce(
      nullif(commitment_row->>'execution_classification', '')::public.execution_classification,
      'committed'::public.execution_classification
    );

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
          execution_classification = next_classification,
          metadata = metadata || jsonb_build_object(
            'client_ref', commitment_row->>'client_ref',
            'evidence_source', commitment_row->>'evidence_source',
            'analysis_generation', p_generation,
            'consolidated_from_refs', coalesce(commitment_row->'consolidated_from_refs', '[]'::jsonb)
          )
      where id = target_commitment_id;
    else
      insert into public.meeting_commitments (
        meeting_id, topic_id, title, description, owner, owners, due_date,
        due_date_text, priority, status, confidence, source_quote,
        source_segment_ids, type, completion_state, execution_classification, metadata
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
        next_classification,
        jsonb_build_object(
          'client_ref', commitment_row->>'client_ref',
          'evidence_source', commitment_row->>'evidence_source',
          'analysis_generation', p_generation,
          'consolidated_from_refs', coalesce(commitment_row->'consolidated_from_refs', '[]'::jsonb)
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
    next_classification := coalesce(
      nullif(task_row->>'execution_classification', '')::public.execution_classification,
      'committed'::public.execution_classification
    );

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
          execution_classification = next_classification,
          extraction_metadata = extraction_metadata || jsonb_build_object(
            'client_ref', task_row->>'client_ref',
            'commitment_ref', task_row->>'commitment_ref',
            'evidence_source', task_row->>'evidence_source',
            'analysis_generation', p_generation,
            'consolidated_from_refs', coalesce(task_row->'consolidated_from_refs', '[]'::jsonb)
          )
      where id = target_task_id;
    else
      insert into public.meeting_tasks (
        meeting_id, topic_id, commitment_id, task, owner, owners, task_type,
        priority, suggested_steps, source_quote, source_segment_ids, confidence,
        due_date, due_date_text, workspace_type, workspace_summary, inferred,
        execution_classification, extraction_metadata
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
        next_classification,
        jsonb_build_object(
          'client_ref', task_row->>'client_ref',
          'commitment_ref', task_row->>'commitment_ref',
          'evidence_source', task_row->>'evidence_source',
          'analysis_generation', p_generation,
          'consolidated_from_refs', coalesce(task_row->'consolidated_from_refs', '[]'::jsonb)
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
    'commitment_count', commitment_count,
    'task_count', task_count,
    'retained_task_count', retained_task_count,
    'deleted_task_count', deleted_task_count
  );
end;
$$;

comment on function public.replace_meeting_execution_graph(uuid, bigint, jsonb, jsonb) is
  'Atomically replace a meeting execution graph for one analysis generation, preserving protected rows and execution_classification.';

revoke all on function public.replace_meeting_execution_graph(uuid, bigint, jsonb, jsonb) from public;
revoke all on function public.replace_meeting_execution_graph(uuid, bigint, jsonb, jsonb) from anon;
revoke all on function public.replace_meeting_execution_graph(uuid, bigint, jsonb, jsonb) from authenticated;
grant execute on function public.replace_meeting_execution_graph(uuid, bigint, jsonb, jsonb) to service_role;

-- Final multi-deliverable lifecycle functions.
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


-- Speaker-independent atomic project-person correction.
-- Atomic, version-checked Project Brain correction for the existing name-based
-- project identity model. This deliberately does not introduce a Person table.

create or replace function public.apply_project_person_correction(
  p_proposal_id uuid,
  p_actor_id uuid,
  p_operation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  proposal_row public.project_change_proposals%rowtype;
  project_row public.projects%rowtype;
  source_name text;
  destination_name text;
  source_key text;
  destination_key text;
  task_ids uuid[];
  commitment_ids uuid[];
  project_participant_ids uuid[];
  commitment_participant_ids uuid[];
  referenced_count integer;
  matched_count integer;
  participant_row record;
  survivor_id uuid;
  before_value jsonb;
  after_value jsonb;
begin
  select * into proposal_row
  from public.project_change_proposals
  where id = p_proposal_id
  for update;

  if proposal_row.id is null then
    raise exception 'proposal_not_found' using errcode = 'P0002';
  end if;

  select * into project_row
  from public.projects
  where id = proposal_row.project_id
  for update;

  if project_row.owner_id <> p_actor_id then
    raise exception 'project_access_denied' using errcode = '42501';
  end if;
  if proposal_row.status not in ('pending_review', 'approved') then
    raise exception 'proposal_not_applicable' using errcode = '22023';
  end if;
  if project_row.execution_graph_version <> proposal_row.base_graph_version then
    update public.project_change_proposals
    set status = 'superseded'
    where id = proposal_row.id;
    return jsonb_build_object(
      'applied', false,
      'stale', true,
      'currentGraphVersion', project_row.execution_graph_version
    );
  end if;
  if p_operation->>'type' is distinct from 'correct_project_person'
    or jsonb_typeof(p_operation->'affectedReferences') is distinct from 'array'
  then
    raise exception 'invalid_person_correction' using errcode = '22023';
  end if;

  if jsonb_array_length(p_operation->'affectedReferences') = 0
    or exists (
      select 1
      from jsonb_array_elements(p_operation->'affectedReferences') reference
      where reference->>'type' not in (
        'task', 'commitment', 'project_participant', 'commitment_participant'
      )
    )
  then
    raise exception 'invalid_person_correction' using errcode = '22023';
  end if;

  source_name := btrim(p_operation->>'sourceName');
  destination_name := btrim(p_operation->>'destinationName');
  source_key := lower(source_name);
  destination_key := lower(destination_name);
  if source_name is null or destination_name is null
    or source_name = '' or destination_name = '' or source_key = destination_key
  then
    raise exception 'invalid_person_names' using errcode = '22023';
  end if;

  task_ids := array(
    select distinct (reference->>'id')::uuid
    from jsonb_array_elements(p_operation->'affectedReferences') reference
    where reference->>'type' = 'task'
  );
  commitment_ids := array(
    select distinct (reference->>'id')::uuid
    from jsonb_array_elements(p_operation->'affectedReferences') reference
    where reference->>'type' = 'commitment'
  );
  project_participant_ids := array(
    select distinct (reference->>'id')::uuid
    from jsonb_array_elements(p_operation->'affectedReferences') reference
    where reference->>'type' = 'project_participant'
  );
  commitment_participant_ids := array(
    select distinct (reference->>'id')::uuid
    from jsonb_array_elements(p_operation->'affectedReferences') reference
    where reference->>'type' = 'commitment_participant'
  );
  -- Independently prove that the destination already exists somewhere in this
  -- project's supported identity reference model. Never create a new identity.
  if not (
    exists (
      select 1 from public.meeting_tasks task
      where task.project_id = project_row.id and (
        lower(btrim(task.owner)) = destination_key or exists (
          select 1 from jsonb_array_elements_text(coalesce(task.owners, '[]'::jsonb)) value
          where lower(btrim(value)) = destination_key
        )
      )
    ) or exists (
      select 1 from public.meeting_commitments commitment
      where commitment.project_id = project_row.id and (
        lower(btrim(commitment.owner)) = destination_key or
        lower(btrim(commitment.lead_owner_name)) = destination_key or exists (
          select 1 from jsonb_array_elements_text(coalesce(commitment.owners, '[]'::jsonb)) value
          where lower(btrim(value)) = destination_key
        )
      )
    ) or exists (
      select 1 from public.project_participants participant
      where participant.project_id = project_row.id
        and lower(btrim(participant.participant_name)) = destination_key
    ) or exists (
      select 1 from public.commitment_participants participant
      join public.meeting_commitments commitment on commitment.id = participant.commitment_id
      where commitment.project_id = project_row.id
        and lower(btrim(participant.participant_name)) = destination_key
    )
  ) then
    raise exception 'destination_person_not_found' using errcode = '22023';
  end if;

  -- Every submitted stable reference must belong to this project and still
  -- contain the reviewed source identity. A changed reference makes the whole
  -- transaction fail rather than partially applying a stale merge.
  referenced_count := cardinality(task_ids);
  select count(*) into matched_count
  from public.meeting_tasks task
  where task.id = any(task_ids) and task.project_id = project_row.id and (
    lower(btrim(task.owner)) = source_key or exists (
      select 1 from jsonb_array_elements_text(coalesce(task.owners, '[]'::jsonb)) value
      where lower(btrim(value)) = source_key
    )
  );
  if matched_count <> referenced_count then
    raise exception 'task_person_reference_changed' using errcode = '40001';
  end if;

  referenced_count := cardinality(commitment_ids);
  select count(*) into matched_count
  from public.meeting_commitments commitment
  where commitment.id = any(commitment_ids) and commitment.project_id = project_row.id and (
    lower(btrim(commitment.owner)) = source_key or
    lower(btrim(commitment.lead_owner_name)) = source_key or exists (
      select 1 from jsonb_array_elements_text(coalesce(commitment.owners, '[]'::jsonb)) value
      where lower(btrim(value)) = source_key
    )
  );
  if matched_count <> referenced_count then
    raise exception 'commitment_person_reference_changed' using errcode = '40001';
  end if;

  referenced_count := cardinality(project_participant_ids);
  select count(*) into matched_count
  from public.project_participants participant
  where participant.id = any(project_participant_ids)
    and participant.project_id = project_row.id
    and lower(btrim(participant.participant_name)) = source_key;
  if matched_count <> referenced_count then
    raise exception 'project_participant_reference_changed' using errcode = '40001';
  end if;

  referenced_count := cardinality(commitment_participant_ids);
  select count(*) into matched_count
  from public.commitment_participants participant
  join public.meeting_commitments commitment on commitment.id = participant.commitment_id
  where participant.id = any(commitment_participant_ids)
    and commitment.project_id = project_row.id
    and lower(btrim(participant.participant_name)) = source_key;
  if matched_count <> referenced_count then
    raise exception 'commitment_participant_reference_changed' using errcode = '40001';
  end if;

  before_value := jsonb_build_object(
    'sourceName', source_name,
    'destinationName', destination_name,
    'affectedReferences', p_operation->'affectedReferences'
  );

  update public.meeting_tasks task
  set owner = case when lower(btrim(task.owner)) = source_key then destination_name else task.owner end,
      owners = (
        select coalesce(jsonb_agg(distinct replacement.value), '[]'::jsonb)
        from (
          select case when lower(btrim(value)) = source_key then destination_name else value end as value
          from jsonb_array_elements_text(coalesce(task.owners, '[]'::jsonb)) value
        ) replacement
      ),
      preserve_on_reanalysis = true,
      manual_override_fields = coalesce(task.manual_override_fields, '[]'::jsonb)
        || case when lower(btrim(task.owner)) = source_key then '["owner"]'::jsonb else '[]'::jsonb end
        || case when exists (
          select 1 from jsonb_array_elements_text(coalesce(task.owners, '[]'::jsonb)) value
          where lower(btrim(value)) = source_key
        ) then '["owners"]'::jsonb else '[]'::jsonb end
  where task.id = any(task_ids);

  update public.meeting_commitments commitment
  set owner = case when lower(btrim(commitment.owner)) = source_key then destination_name else commitment.owner end,
      lead_owner_name = case
        when lower(btrim(commitment.lead_owner_name)) = source_key then destination_name
        else commitment.lead_owner_name
      end,
      owners = (
        select coalesce(jsonb_agg(distinct replacement.value), '[]'::jsonb)
        from (
          select case when lower(btrim(value)) = source_key then destination_name else value end as value
          from jsonb_array_elements_text(coalesce(commitment.owners, '[]'::jsonb)) value
        ) replacement
      ),
      preserve_on_reanalysis = true,
      manual_override_fields = coalesce(commitment.manual_override_fields, '[]'::jsonb)
        || case when lower(btrim(commitment.owner)) = source_key then '["owner"]'::jsonb else '[]'::jsonb end
        || case when lower(btrim(commitment.lead_owner_name)) = source_key then '["lead_owner_name"]'::jsonb else '[]'::jsonb end
        || case when exists (
          select 1 from jsonb_array_elements_text(coalesce(commitment.owners, '[]'::jsonb)) value
          where lower(btrim(value)) = source_key
        ) then '["owners"]'::jsonb else '[]'::jsonb end
  where commitment.id = any(commitment_ids);

  -- Merge project participant rows without creating duplicate destination names.
  select id into survivor_id
  from public.project_participants
  where project_id = project_row.id and lower(btrim(participant_name)) = destination_key
  order by created_at asc limit 1;
  if survivor_id is null and cardinality(project_participant_ids) > 0 then
    survivor_id := project_participant_ids[1];
    update public.project_participants
    set participant_name = destination_name, manually_confirmed = true
    where id = survivor_id;
  elsif survivor_id is not null then
    update public.project_participants
    set manually_confirmed = true
    where id = survivor_id;
  end if;
  delete from public.project_participants
  where id = any(project_participant_ids) and id is distinct from survivor_id;

  -- Commitment participants are unique per commitment, so merge independently
  -- within each commitment while preserving the destination row when present.
  for participant_row in
    select participant.id, participant.commitment_id
    from public.commitment_participants participant
    where participant.id = any(commitment_participant_ids)
  loop
    select id into survivor_id
    from public.commitment_participants
    where commitment_id = participant_row.commitment_id
      and lower(btrim(participant_name)) = destination_key
    order by created_at asc limit 1;
    if survivor_id is null then
      update public.commitment_participants
      set participant_name = destination_name
      where id = participant_row.id;
    else
      delete from public.commitment_participants where id = participant_row.id;
    end if;
  end loop;

  update public.projects
  set execution_graph_version = execution_graph_version + 1
  where id = project_row.id
  returning execution_graph_version into project_row.execution_graph_version;

  update public.project_change_proposals
  set status = 'applied',
      approved_by = p_actor_id,
      applied_at = timezone('utc', now()),
      resulting_graph_version = project_row.execution_graph_version,
      proposal = jsonb_build_object('operations', jsonb_build_array(p_operation))
  where id = proposal_row.id;

  after_value := jsonb_build_object(
    'sourceName', source_name,
    'destinationName', destination_name,
    'affectedReferenceCount', jsonb_array_length(p_operation->'affectedReferences')
  );
  insert into public.project_change_events (
    project_id, proposal_id, actor_type, actor_id, event_type,
    entity_type, entity_id, before_state, after_state, source_type, source_id
  ) values (
    project_row.id, proposal_row.id, 'user', p_actor_id,
    'correct_project_person', 'project', project_row.id,
    before_value, after_value, 'project_chat', proposal_row.source_message_id
  );
  insert into public.project_change_events (
    project_id, proposal_id, actor_type, actor_id, event_type,
    entity_type, entity_id, before_state, after_state, source_type, source_id
  ) values (
    project_row.id, proposal_row.id, 'user', p_actor_id,
    'proposal_applied', 'project', project_row.id,
    jsonb_build_object('execution_graph_version', proposal_row.base_graph_version),
    jsonb_build_object('execution_graph_version', project_row.execution_graph_version),
    'project_chat', proposal_row.source_message_id
  );

  return jsonb_build_object(
    'applied', true,
    'stale', false,
    'resultingGraphVersion', project_row.execution_graph_version,
    'affectedReferenceCount', jsonb_array_length(p_operation->'affectedReferences')
  );
end;
$$;

comment on function public.apply_project_person_correction(uuid, uuid, jsonb) is
  'Service-role-only atomic Project Brain merge of audited name-based project identity references; does not modify transcript or evidence rows.';

revoke all on function public.apply_project_person_correction(uuid, uuid, jsonb) from public;
revoke all on function public.apply_project_person_correction(uuid, uuid, jsonb) from anon;
revoke all on function public.apply_project_person_correction(uuid, uuid, jsonb) from authenticated;
grant execute on function public.apply_project_person_correction(uuid, uuid, jsonb) to service_role;

-- Atomic dependency provenance wrapper.
-- Atomic wrapper: a Project Brain add_dependency/remove_dependency approval and the resulting
-- manual-dependency-provenance marking must succeed or fail together, in one transaction.
--
-- Previously the API route called apply_project_change_proposal, then made a *separate*
-- application-layer update to mark the affected tasks' manual_override_fields/
-- preserve_on_reanalysis. If that second call failed after the first committed, a human-approved
-- add_dependency/remove_dependency decision would exist in task_dependencies (or, for a removal,
-- exist only as an absence) while still reading as AI-unlocked -- later AI dependency inference
-- could then silently overwrite it. This wrapper closes that gap by doing both inside a single
-- Postgres function invocation: if the provenance update fails, Postgres rolls back everything
-- the inner apply_project_change_proposal call already did too, since nothing commits until this
-- function returns.
--
-- The final apply_project_change_proposal function is defined above. This wrapper only calls it
-- and post-processes its already-validated p_operations input, mirroring exactly how
-- the manual dependency picker's provenance marking works (preserve_on_reanalysis = true,
-- "dependencies" appended to manual_override_fields, idempotently).
create or replace function public.apply_project_change_proposal_with_dependency_provenance(
  p_proposal_id uuid,
  p_actor_id uuid,
  p_operations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
  operation jsonb;
  affected_task_id uuid;
begin
  -- apply_project_change_proposal is all-or-nothing: any invalid/unauthorized operation raises
  -- an exception that aborts this whole function call (and therefore this whole transaction,
  -- including anything below), so by the time it returns without raising, every operation in
  -- p_operations was genuinely applied. The one exception is the version-conflict ("stale")
  -- path, which returns normally without applying anything -- detected and short-circuited below
  -- so no provenance is ever marked for operations that were never actually applied.
  result := public.apply_project_change_proposal(p_proposal_id, p_actor_id, p_operations);

  if coalesce((result->>'stale')::boolean, false) then
    return result;
  end if;

  for operation in select value from jsonb_array_elements(p_operations)
  loop
    if operation->>'type' in ('add_dependency', 'remove_dependency') then
      -- Both an add and a removal are equally meaningful human decisions (a removal's "no
      -- dependency" choice has no row of its own in task_dependencies to point to -- this
      -- manual_override_fields entry is the only durable record of it).
      affected_task_id := (operation->>'taskId')::uuid;
      update public.meeting_tasks
      set preserve_on_reanalysis = true,
          manual_override_fields = case
            when coalesce(manual_override_fields, '[]'::jsonb) @> '["dependencies"]'::jsonb
              then coalesce(manual_override_fields, '[]'::jsonb)
            else coalesce(manual_override_fields, '[]'::jsonb) || '["dependencies"]'::jsonb
          end
      where id = affected_task_id;
    end if;
  end loop;

  return result;
end;
$$;

comment on function public.apply_project_change_proposal_with_dependency_provenance(uuid, uuid, jsonb) is
  'Service-role-only atomic wrapper: applies a Project Brain proposal via apply_project_change_proposal, then marks manual dependency provenance for any approved add_dependency/remove_dependency operations, all in one transaction.';

revoke all on function public.apply_project_change_proposal_with_dependency_provenance(uuid, uuid, jsonb) from public;
revoke all on function public.apply_project_change_proposal_with_dependency_provenance(uuid, uuid, jsonb) from anon;
revoke all on function public.apply_project_change_proposal_with_dependency_provenance(uuid, uuid, jsonb) from authenticated;
grant execute on function public.apply_project_change_proposal_with_dependency_provenance(uuid, uuid, jsonb) to service_role;

-- Meeting-level assistant conversation persistence.
-- Meeting-level "Ask Parfait" conversation persistence.
--
-- Audit finding: task_comments and commitment_comments both exist, but each is foreign-keyed to
-- its owning task/commitment specifically (task_id/commitment_id), not to a meeting. Neither can
-- represent a conversation scoped to an entire meeting -- there is no existing table a meeting-
-- level assistant could safely reuse without conflating unrelated task/commitment threads. This
-- is a genuinely new capability, so a small forward migration is required; it is not a substitute
-- for or a change to either existing table.
--
-- Shape is intentionally identical to commitment_comments (id, owning-entity id, user_id, role,
-- message, metadata, created_at) -- metadata carries the structured response type (answer /
-- generated_content / clarification / declined_mutation) and any generated-content/source
-- references the UI renders, mirroring task_comments.metadata's existing use for structured
-- assistant output.
create table public.meeting_comments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'system')),
  message text not null check (length(trim(message)) > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index meeting_comments_meeting_id_created_at_idx
on public.meeting_comments (meeting_id, created_at);

alter table public.meeting_comments enable row level security;

-- Scoped to user + meeting via meetings.user_id, exactly like task_comments/commitment_comments
-- scope through their own owning entity -- a meeting has exactly one owning user in this schema,
-- so "scoped to user + meeting" and "scoped to meeting" are the same constraint here.
create policy "meeting_comments_owner_select"
on public.meeting_comments
for select
using (
  exists (
    select 1
    from public.meetings meeting
    where meeting.id = meeting_comments.meeting_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
);

create policy "meeting_comments_owner_insert"
on public.meeting_comments
for insert
with check (
  role = 'user'
  and user_id = auth.uid()
  and exists (
    select 1
    from public.meetings meeting
    where meeting.id = meeting_comments.meeting_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
);

-- Remove all automatic/default table privileges first, then install only the
-- repository's required Supabase API DML privileges.
revoke all on table
  public.account_verification_events,
  public.user_integrations,
  public.projects,
  public.meeting_commitments,
  public.meeting_analysis_jobs,
  public.meeting_conversation_events,
  public.task_dependencies,
  public.commitment_participants,
  public.commitment_comments,
  public.meeting_comments,
  public.project_memory,
  public.project_requirements,
  public.project_decisions,
  public.project_constraints,
  public.project_participants,
  public.project_chat_threads,
  public.project_chat_messages,
  public.project_change_proposals,
  public.project_change_events
from public, anon, authenticated, service_role;

grant select, insert, update, delete on table
  public.account_verification_events,
  public.user_integrations,
  public.projects,
  public.meeting_commitments,
  public.meeting_analysis_jobs,
  public.meeting_conversation_events,
  public.task_dependencies,
  public.commitment_participants,
  public.commitment_comments,
  public.meeting_comments,
  public.project_memory,
  public.project_requirements,
  public.project_decisions,
  public.project_constraints,
  public.project_participants,
  public.project_chat_threads,
  public.project_chat_messages,
  public.project_change_proposals,
  public.project_change_events
to anon, authenticated, service_role;


-- Trigger-only functions are invoked by their installed triggers, not through
-- the Data API. The owner retains control.
revoke all on function public.set_updated_at() from public, anon, authenticated, service_role;
revoke all on function public.handle_new_auth_user() from public, anon, authenticated, service_role;
revoke all on function public.sync_execution_row_project() from public, anon, authenticated, service_role;
revoke all on function public.preserve_converted_commitment() from public, anon, authenticated, service_role;
revoke all on function public.reject_task_dependency_cycle() from public, anon, authenticated, service_role;
revoke all on function public.sync_commitment_lead_owner() from public, anon, authenticated, service_role;
revoke all on function public.preserve_manual_task_parent() from public, anon, authenticated, service_role;
revoke all on function public.preserve_manual_task_classification() from public, anon, authenticated, service_role;
revoke all on function public.preserve_manual_commitment_classification() from public, anon, authenticated, service_role;

-- RLS access helper.
revoke all on function public.can_access_project(uuid) from public, anon, authenticated, service_role;
grant execute on function public.can_access_project(uuid) to authenticated, service_role;

-- Service-only mutation and lifecycle RPCs.
revoke all on function public.claim_meeting_execution_analysis(uuid) from public, anon, authenticated;
grant execute on function public.claim_meeting_execution_analysis(uuid) to service_role;
revoke all on function public.replace_meeting_execution_graph(uuid, bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_meeting_execution_graph(uuid, bigint, jsonb, jsonb) to service_role;
revoke all on function public.claim_meeting_analysis_job(uuid) from public, anon, authenticated;
grant execute on function public.claim_meeting_analysis_job(uuid) to service_role;
revoke all on function public.replace_meeting_conversation_events(uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.replace_meeting_conversation_events(uuid, bigint, jsonb) to service_role;
revoke all on function public.replace_task_dependencies(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.replace_task_dependencies(uuid, uuid[]) to service_role;
revoke all on function public.assign_meeting_project(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_meeting_project(uuid, uuid) to service_role;
revoke all on function public.merge_commitment_tasks(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.merge_commitment_tasks(uuid, uuid, uuid[]) to service_role;
revoke all on function public.task_has_accepted_current_deliverable(uuid) from public, anon, authenticated;
grant execute on function public.task_has_accepted_current_deliverable(uuid) to service_role;
revoke all on function public.create_deliverable_version(uuid, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_deliverable_version(uuid, text, text, text, text, text, jsonb) to service_role;
revoke all on function public.accept_deliverable(uuid, uuid) from public, anon, authenticated;
grant execute on function public.accept_deliverable(uuid, uuid) to service_role;
revoke all on function public.reopen_deliverable(uuid) from public, anon, authenticated;
grant execute on function public.reopen_deliverable(uuid) to service_role;
revoke all on function public.apply_project_change_proposal(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_project_change_proposal(uuid, uuid, jsonb) to service_role;
revoke all on function public.apply_project_change_proposal_with_dependency_provenance(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_project_change_proposal_with_dependency_provenance(uuid, uuid, jsonb) to service_role;
revoke all on function public.apply_project_person_correction(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_project_person_correction(uuid, uuid, jsonb) to service_role;
