alter type public.meeting_status add value if not exists 'transcript_ready';

create table if not exists public.meeting_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  generation bigint not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'stale')),
  current_stage text not null default 'queued',
  progress integer not null default 0 check (progress between 0 and 100),
  error text,
  retry_count integer not null default 0 check (retry_count >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (meeting_id, generation)
);

create index if not exists meeting_analysis_jobs_latest_idx
on public.meeting_analysis_jobs (meeting_id, generation desc);

drop trigger if exists meeting_analysis_jobs_set_updated_at
on public.meeting_analysis_jobs;
create trigger meeting_analysis_jobs_set_updated_at
before update on public.meeting_analysis_jobs
for each row execute procedure public.set_updated_at();

alter table public.meeting_analysis_jobs enable row level security;

drop policy if exists "Users can view own meeting analysis jobs"
on public.meeting_analysis_jobs;
create policy "Users can view own meeting analysis jobs"
on public.meeting_analysis_jobs
for select
using (
  exists (
    select 1
    from public.meetings
    where meetings.id = meeting_analysis_jobs.meeting_id
      and meetings.user_id = auth.uid()
      and meetings.deleted_at is null
  )
);

create or replace function public.claim_meeting_analysis_job(
  p_meeting_id uuid
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  claimed_generation bigint;
  claimed_job_id uuid;
begin
  update public.meetings
  set execution_graph_generation = execution_graph_generation + 1
  where id = p_meeting_id
    and deleted_at is null
  returning execution_graph_generation into claimed_generation;

  if claimed_generation is null then
    raise exception 'Meeting % does not exist or has been deleted', p_meeting_id
      using errcode = 'P0002';
  end if;

  update public.meeting_analysis_jobs
  set status = 'stale',
      current_stage = 'stale',
      error = 'Superseded by a newer analysis generation.',
      completed_at = now()
  where meeting_id = p_meeting_id
    and status in ('queued', 'running');

  insert into public.meeting_analysis_jobs (
    meeting_id,
    generation,
    status,
    current_stage,
    progress
  )
  values (
    p_meeting_id,
    claimed_generation,
    'queued',
    'queued',
    0
  )
  returning id into claimed_job_id;

  return jsonb_build_object(
    'job_id', claimed_job_id,
    'generation', claimed_generation
  );
end;
$$;

comment on function public.claim_meeting_analysis_job(uuid) is
  'Atomically claims the next analysis generation, stales older active jobs, and creates its queued job.';

revoke all on function public.claim_meeting_analysis_job(uuid) from public;
revoke all on function public.claim_meeting_analysis_job(uuid) from anon;
revoke all on function public.claim_meeting_analysis_job(uuid) from authenticated;
grant execute on function public.claim_meeting_analysis_job(uuid) to service_role;
