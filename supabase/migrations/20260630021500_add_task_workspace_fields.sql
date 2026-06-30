alter table public.meeting_tasks
add column if not exists workspace_type text not null default 'other';

alter table public.meeting_tasks
add column if not exists workspace_summary text;

alter table public.meeting_tasks
drop constraint if exists meeting_tasks_workspace_type_check;

alter table public.meeting_tasks
add constraint meeting_tasks_workspace_type_check
check (
  workspace_type in (
    'research',
    'email',
    'proposal',
    'coding',
    'documentation',
    'design',
    'meeting_follow_up',
    'planning',
    'testing',
    'decision',
    'learning',
    'other'
  )
);

update public.meeting_tasks
set workspace_type = 'other'
where workspace_type is null;

create index if not exists meeting_tasks_workspace_type_idx
on public.meeting_tasks (workspace_type);
