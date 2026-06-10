create extension if not exists "pgcrypto";

do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'meeting_status' and n.nspname = 'public'
  ) then
    create type public.meeting_status as enum (
      'pending',
      'joining',
      'in_progress',
      'completed',
      'failed'
    );
  end if;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text,
  meeting_url text not null,
  recall_bot_id text unique,
  status public.meeting_status not null default 'pending',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  speaker_name text,
  content text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.extracted_insights (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  category text not null,
  content text not null,
  confidence numeric(3,2),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.extracted_insights
drop constraint if exists extracted_insights_category_check;

alter table public.extracted_insights
add constraint extracted_insights_category_check
check (
  category in (
    'product_summary',
    'requirements',
    'product_requirements',
    'features',
    'user_stories',
    'technical_constraints',
    'design_preferences',
    'implementation_details',
    'open_questions',
    'risks',
    'next_steps'
  )
);

create table if not exists public.generated_prompts (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  target_tool text not null check (target_tool in ('codex', 'claude_code', 'lovable')),
  prompt text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists meetings_user_id_idx on public.meetings (user_id);
create index if not exists meetings_created_at_idx on public.meetings (created_at desc);
create index if not exists transcript_segments_meeting_id_idx on public.transcript_segments (meeting_id);
create index if not exists transcript_segments_started_at_idx on public.transcript_segments (started_at);
create index if not exists extracted_insights_meeting_id_idx on public.extracted_insights (meeting_id);
create index if not exists extracted_insights_category_idx on public.extracted_insights (category);
create index if not exists generated_prompts_meeting_id_idx on public.generated_prompts (meeting_id);
create index if not exists generated_prompts_target_tool_idx on public.generated_prompts (target_tool);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute procedure public.set_updated_at();

drop trigger if exists meetings_set_updated_at on public.meetings;
create trigger meetings_set_updated_at
before update on public.meetings
for each row execute procedure public.set_updated_at();

drop trigger if exists transcript_segments_set_updated_at on public.transcript_segments;
create trigger transcript_segments_set_updated_at
before update on public.transcript_segments
for each row execute procedure public.set_updated_at();

drop trigger if exists extracted_insights_set_updated_at on public.extracted_insights;
create trigger extracted_insights_set_updated_at
before update on public.extracted_insights
for each row execute procedure public.set_updated_at();

drop trigger if exists generated_prompts_set_updated_at on public.generated_prompts;
create trigger generated_prompts_set_updated_at
before update on public.generated_prompts
for each row execute procedure public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_auth_user();

alter table public.profiles enable row level security;
alter table public.meetings enable row level security;
alter table public.transcript_segments enable row level security;
alter table public.extracted_insights enable row level security;
alter table public.generated_prompts enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles
for insert
with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles
for update
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "meetings_owner_all" on public.meetings;
create policy "meetings_owner_all"
on public.meetings
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "transcript_segments_owner_all" on public.transcript_segments;
create policy "transcript_segments_owner_all"
on public.transcript_segments
for all
using (
  exists (
    select 1
    from public.meetings m
    where m.id = transcript_segments.meeting_id
      and m.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.meetings m
    where m.id = transcript_segments.meeting_id
      and m.user_id = auth.uid()
  )
);

drop policy if exists "extracted_insights_owner_all" on public.extracted_insights;
create policy "extracted_insights_owner_all"
on public.extracted_insights
for all
using (
  exists (
    select 1
    from public.meetings m
    where m.id = extracted_insights.meeting_id
      and m.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.meetings m
    where m.id = extracted_insights.meeting_id
      and m.user_id = auth.uid()
  )
);

drop policy if exists "generated_prompts_owner_all" on public.generated_prompts;
create policy "generated_prompts_owner_all"
on public.generated_prompts
for all
using (
  exists (
    select 1
    from public.meetings m
    where m.id = generated_prompts.meeting_id
      and m.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.meetings m
    where m.id = generated_prompts.meeting_id
      and m.user_id = auth.uid()
  )
);
