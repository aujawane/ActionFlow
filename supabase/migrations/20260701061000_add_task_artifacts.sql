create table if not exists public.task_artifacts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.meeting_tasks (id) on delete cascade,
  artifact_type text not null,
  title text not null,
  content text not null,
  version integer not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists task_artifacts_task_id_idx
on public.task_artifacts (task_id);

create index if not exists task_artifacts_created_at_idx
on public.task_artifacts (created_at desc);

drop trigger if exists task_artifacts_set_updated_at on public.task_artifacts;
create trigger task_artifacts_set_updated_at
before update on public.task_artifacts
for each row execute procedure public.set_updated_at();

alter table public.task_artifacts enable row level security;

drop policy if exists "task_artifacts_owner_all" on public.task_artifacts;
create policy "task_artifacts_owner_all"
on public.task_artifacts
for all
using (
  exists (
    select 1
    from public.meeting_tasks mt
    join public.meetings m on m.id = mt.meeting_id
    where mt.id = task_artifacts.task_id
      and m.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.meeting_tasks mt
    join public.meetings m on m.id = mt.meeting_id
    where mt.id = task_artifacts.task_id
      and m.user_id = auth.uid()
  )
);
