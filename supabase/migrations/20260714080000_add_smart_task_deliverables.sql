alter table public.meeting_tasks
add column if not exists categorization_metadata jsonb not null default '{}'::jsonb;

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
    'other',
    'website_change',
    'scheduling',
    'follow_up',
    'analysis',
    'document'
  )
);

alter table public.task_artifacts
add column if not exists deliverable_type text,
add column if not exists status text not null default 'generated',
add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.task_artifacts
drop constraint if exists task_artifacts_status_check;

alter table public.task_artifacts
add constraint task_artifacts_status_check
check (status in ('generated', 'edited', 'failed'));

update public.task_artifacts
set
  status = 'generated',
  metadata = coalesce(metadata, '{}'::jsonb)
where status is null;
