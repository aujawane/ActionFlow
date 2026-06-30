create table if not exists public.meeting_tasks (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  topic_id uuid not null references public.meeting_topics (id) on delete cascade,
  task text not null,
  owner text,
  task_type text not null check (
    task_type in ('commitment', 'implicit_commitment', 'unassigned_work')
  ),
  priority text not null default 'medium' check (
    priority in ('low', 'medium', 'high')
  ),
  suggested_steps jsonb not null default '[]'::jsonb,
  source_quote text,
  confidence numeric,
  status text not null default 'pending' check (
    status in ('pending', 'in_progress', 'completed', 'dismissed')
  ),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists meeting_tasks_meeting_id_idx
on public.meeting_tasks (meeting_id);

create index if not exists meeting_tasks_topic_id_idx
on public.meeting_tasks (topic_id);

create index if not exists meeting_tasks_status_idx
on public.meeting_tasks (status);

create unique index if not exists meeting_tasks_dedupe_idx
on public.meeting_tasks (
  meeting_id,
  topic_id,
  task_type,
  lower(task)
);

alter table public.meeting_tasks enable row level security;

drop policy if exists "meeting_tasks_owner_all" on public.meeting_tasks;
create policy "meeting_tasks_owner_all"
on public.meeting_tasks
for all
using (
  exists (
    select 1
    from public.meetings m
    where m.id = meeting_tasks.meeting_id
      and m.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.meetings m
    where m.id = meeting_tasks.meeting_id
      and m.user_id = auth.uid()
  )
);
