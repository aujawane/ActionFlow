alter table public.meeting_analysis_jobs
add column if not exists checkpoint jsonb not null default '{}'::jsonb;

comment on column public.meeting_analysis_jobs.checkpoint is
  'Intermediate analysis state shared across chained worker invocations.';
