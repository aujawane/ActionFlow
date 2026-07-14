alter table public.meeting_tasks
add column if not exists rationale text,
add column if not exists supporting_context text;

alter table public.task_comments
add column if not exists metadata jsonb not null default '{}'::jsonb;
