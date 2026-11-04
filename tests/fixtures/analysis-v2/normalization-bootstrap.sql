-- Minimal LOCAL scratch baseline for transactional v2 normalization tests. Not a migration.
create table public.projects (
  id uuid primary key default gen_random_uuid()
);

alter table public.meetings
  add column project_id uuid references public.projects(id) on delete set null,
  add column created_at timestamptz not null default now();

create table public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  speaker text,
  participant_name text,
  text text not null,
  "timestamp" timestamptz not null,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create function public.can_access_project(uuid)
returns boolean language sql stable as $$ select true $$;

grant all on public.projects, public.transcript_segments to service_role;
