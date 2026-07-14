create table if not exists public.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.meeting_tasks (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'system')),
  message text not null check (length(trim(message)) > 0),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists task_comments_task_id_created_at_idx
on public.task_comments (task_id, created_at);

alter table public.task_comments enable row level security;

drop policy if exists "task_comments_owner_select" on public.task_comments;
create policy "task_comments_owner_select"
on public.task_comments
for select
using (
  exists (
    select 1
    from public.meeting_tasks task
    join public.meetings meeting on meeting.id = task.meeting_id
    where task.id = task_comments.task_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
);

drop policy if exists "task_comments_owner_insert" on public.task_comments;
create policy "task_comments_owner_insert"
on public.task_comments
for insert
with check (
  role = 'user'
  and user_id = auth.uid()
  and exists (
    select 1
    from public.meeting_tasks task
    join public.meetings meeting on meeting.id = task.meeting_id
    where task.id = task_comments.task_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
);
