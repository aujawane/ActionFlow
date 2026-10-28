-- Minimal LOCAL scratch baseline for B1, applied after bootstrap.sql. Not a staging migration.
-- Legacy tables predate supabase/migrations. extracted_insights mirrors the live parfait-staging
-- catalog (read 2026-10-27): NO category check constraint, although supabase/schema.sql
-- declares one (stale; it also omits 'decisions', which staging stores).
create table public.extracted_insights (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  category text not null,
  content text not null,
  confidence numeric(3,2),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create table public.generated_prompts (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  prompt text not null
);
