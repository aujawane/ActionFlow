create table if not exists public.meeting_commitments (
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
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists meeting_commitments_meeting_id_idx
on public.meeting_commitments (meeting_id);

create index if not exists meeting_commitments_topic_id_idx
on public.meeting_commitments (topic_id);

create index if not exists meeting_commitments_status_idx
on public.meeting_commitments (status);

create unique index if not exists meeting_commitments_dedupe_idx
on public.meeting_commitments (meeting_id, lower(title), coalesce(owner, ''));

alter table public.meeting_commitments enable row level security;

drop policy if exists "meeting_commitments_owner_all" on public.meeting_commitments;
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

alter table public.meeting_tasks
add column if not exists commitment_id uuid references public.meeting_commitments (id) on delete set null,
add column if not exists owners jsonb not null default '[]'::jsonb,
add column if not exists due_date_text text,
add column if not exists source_segment_ids jsonb not null default '[]'::jsonb,
add column if not exists inferred boolean not null default false,
add column if not exists extraction_metadata jsonb not null default '{}'::jsonb;

alter table public.meeting_tasks
alter column topic_id drop not null;

alter table public.meeting_tasks
drop constraint if exists meeting_tasks_topic_id_fkey;

alter table public.meeting_tasks
add constraint meeting_tasks_topic_id_fkey
foreign key (topic_id) references public.meeting_topics (id) on delete set null;

create index if not exists meeting_tasks_commitment_id_idx
on public.meeting_tasks (commitment_id);

drop trigger if exists meeting_commitments_set_updated_at on public.meeting_commitments;
create trigger meeting_commitments_set_updated_at
before update on public.meeting_commitments
for each row execute procedure public.set_updated_at();

create or replace function public.replace_meeting_execution_graph(
  p_meeting_id uuid,
  p_commitments jsonb,
  p_tasks jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  commitment_row jsonb;
  task_row jsonb;
  inserted_commitment_id uuid;
  commitment_refs jsonb := '{}'::jsonb;
  commitment_count integer := 0;
  task_count integer := 0;
begin
  delete from public.meeting_tasks where meeting_id = p_meeting_id;
  delete from public.meeting_commitments where meeting_id = p_meeting_id;

  for commitment_row in
    select value from jsonb_array_elements(coalesce(p_commitments, '[]'::jsonb))
  loop
    insert into public.meeting_commitments (
      meeting_id,
      topic_id,
      title,
      description,
      owner,
      owners,
      due_date,
      due_date_text,
      priority,
      status,
      confidence,
      source_quote,
      source_segment_ids,
      type,
      completion_state,
      metadata
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
        'evidence_source', commitment_row->>'evidence_source'
      )
    )
    returning id into inserted_commitment_id;

    commitment_refs := commitment_refs ||
      jsonb_build_object(commitment_row->>'client_ref', inserted_commitment_id::text);
    commitment_count := commitment_count + 1;
  end loop;

  for task_row in
    select value from jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb))
  loop
    insert into public.meeting_tasks (
      meeting_id,
      topic_id,
      commitment_id,
      task,
      owner,
      owners,
      task_type,
      priority,
      suggested_steps,
      source_quote,
      source_segment_ids,
      confidence,
      due_date,
      due_date_text,
      workspace_type,
      workspace_summary,
      inferred,
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
        'evidence_source', task_row->>'evidence_source'
      )
    );
    task_count := task_count + 1;
  end loop;

  return jsonb_build_object(
    'commitments', commitment_count,
    'tasks', task_count
  );
end;
$$;
