-- Project Brain Phase 1: durable project context, chat, reviewable proposals,
-- versioned atomic graph mutation, and audit history.
-- Additive only. Do not apply to production before staging verification.

alter table public.projects
add column if not exists execution_graph_version bigint not null default 0
  check (execution_graph_version >= 0);

create table if not exists public.project_memory (
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

create table if not exists public.project_requirements (
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

create unique index if not exists project_requirements_title_idx
on public.project_requirements (project_id, lower(title));

create table if not exists public.project_decisions (
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

create unique index if not exists project_decisions_title_idx
on public.project_decisions (project_id, lower(title));

create table if not exists public.project_constraints (
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

create unique index if not exists project_constraints_title_idx
on public.project_constraints (project_id, lower(title));

create table if not exists public.project_participants (
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

create table if not exists public.project_chat_threads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null default 'Project Brain',
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists project_chat_threads_project_updated_idx
on public.project_chat_threads (project_id, updated_at desc);

create table if not exists public.project_chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.project_chat_threads (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null check (length(trim(content)) > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists project_chat_messages_thread_created_idx
on public.project_chat_messages (thread_id, created_at);

create table if not exists public.project_change_proposals (
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

create index if not exists project_change_proposals_project_created_idx
on public.project_change_proposals (project_id, created_at desc);

create table if not exists public.project_change_events (
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

create index if not exists project_change_events_project_created_idx
on public.project_change_events (project_id, created_at desc);

drop trigger if exists project_memory_set_updated_at on public.project_memory;
create trigger project_memory_set_updated_at before update on public.project_memory
for each row execute procedure public.set_updated_at();
drop trigger if exists project_requirements_set_updated_at on public.project_requirements;
create trigger project_requirements_set_updated_at before update on public.project_requirements
for each row execute procedure public.set_updated_at();
drop trigger if exists project_decisions_set_updated_at on public.project_decisions;
create trigger project_decisions_set_updated_at before update on public.project_decisions
for each row execute procedure public.set_updated_at();
drop trigger if exists project_constraints_set_updated_at on public.project_constraints;
create trigger project_constraints_set_updated_at before update on public.project_constraints
for each row execute procedure public.set_updated_at();
drop trigger if exists project_participants_set_updated_at on public.project_participants;
create trigger project_participants_set_updated_at before update on public.project_participants
for each row execute procedure public.set_updated_at();
drop trigger if exists project_chat_threads_set_updated_at on public.project_chat_threads;
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

drop policy if exists "project_memory_owner_all" on public.project_memory;
create policy "project_memory_owner_all" on public.project_memory for all
using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));
drop policy if exists "project_requirements_owner_all" on public.project_requirements;
create policy "project_requirements_owner_all" on public.project_requirements for all
using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));
drop policy if exists "project_decisions_owner_all" on public.project_decisions;
create policy "project_decisions_owner_all" on public.project_decisions for all
using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));
drop policy if exists "project_constraints_owner_all" on public.project_constraints;
create policy "project_constraints_owner_all" on public.project_constraints for all
using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));
drop policy if exists "project_participants_owner_all" on public.project_participants;
create policy "project_participants_owner_all" on public.project_participants for all
using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));
drop policy if exists "project_chat_threads_owner_all" on public.project_chat_threads;
create policy "project_chat_threads_owner_all" on public.project_chat_threads for all
using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));
drop policy if exists "project_chat_messages_owner_all" on public.project_chat_messages;
drop policy if exists "project_chat_messages_owner_select" on public.project_chat_messages;
create policy "project_chat_messages_owner_select"
on public.project_chat_messages for select
using (public.can_access_project(project_id));
drop policy if exists "project_chat_messages_user_insert" on public.project_chat_messages;
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
drop policy if exists "project_change_proposals_owner_all" on public.project_change_proposals;
drop policy if exists "project_change_proposals_owner_select" on public.project_change_proposals;
create policy "project_change_proposals_owner_select"
on public.project_change_proposals for select
using (public.can_access_project(project_id));
drop policy if exists "project_change_events_owner_select" on public.project_change_events;
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

drop trigger if exists meeting_tasks_preserve_manual_parent
on public.meeting_tasks;
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
