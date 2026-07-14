create table if not exists public.meeting_artifacts (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  artifact_type text not null,
  title text not null,
  content text,
  status text not null default 'generated',
  metadata jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint meeting_artifacts_artifact_type_check check (
    artifact_type in ('follow_up_email_individual', 'follow_up_email_team_summary')
  ),
  constraint meeting_artifacts_status_check check (
    status in ('generated', 'edited', 'failed')
  )
);

create index if not exists meeting_artifacts_meeting_id_idx
on public.meeting_artifacts (meeting_id);

create index if not exists meeting_artifacts_type_version_idx
on public.meeting_artifacts (meeting_id, artifact_type, version desc);

drop trigger if exists meeting_artifacts_set_updated_at on public.meeting_artifacts;
create trigger meeting_artifacts_set_updated_at
before update on public.meeting_artifacts
for each row execute procedure public.set_updated_at();

alter table public.meeting_artifacts enable row level security;

drop policy if exists "meeting_artifacts_owner_all" on public.meeting_artifacts;
create policy "meeting_artifacts_owner_all"
on public.meeting_artifacts
for all
using (
  exists (
    select 1
    from public.meetings m
    where m.id = meeting_artifacts.meeting_id
      and m.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.meetings m
    where m.id = meeting_artifacts.meeting_id
      and m.user_id = auth.uid()
  )
);
