alter table public.meeting_tasks
add column if not exists due_date date;
