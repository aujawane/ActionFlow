-- Minimal LOCAL scratch baseline only, not a staging migration.
-- Reproduces the column shapes verified live on staging and Production (2026-11) for the two
-- tables the manual-transcript-import migration touches: meetings.meeting_url text NOT NULL with no
-- default, transcript_segments."timestamp" timestamptz NOT NULL with no default, raw_payload jsonb
-- NOT NULL default '{}', and no source / meeting_date columns.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
end $$;

create type public.meeting_status as enum (
  'pending', 'joining', 'recording', 'completed', 'failed', 'processing', 'transcript_ready'
);

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text,
  meeting_url text not null,
  recall_bot_id text unique,
  status public.meeting_status not null default 'pending',
  platform text not null default 'google_meet'
    constraint meetings_platform_check check (platform in ('google_meet', 'zoom', 'unknown')),
  is_pinned boolean not null default false,
  deleted_at timestamptz,
  execution_graph_generation bigint not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  speaker text,
  participant_name text,
  text text not null,
  "timestamp" timestamptz not null,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

grant usage on schema public to anon, authenticated, service_role;
grant all on public.meetings, public.transcript_segments to service_role;
