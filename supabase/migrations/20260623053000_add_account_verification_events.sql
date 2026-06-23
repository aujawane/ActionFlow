create table if not exists public.account_verification_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  event_type text not null check (
    event_type in (
      'password_code_requested',
      'password_code_rate_limited',
      'password_change_verified',
      'password_change_failed'
    )
  ),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists account_verification_events_user_created_idx
on public.account_verification_events (user_id, created_at desc);

alter table public.account_verification_events enable row level security;

drop policy if exists "account_verification_events_select_own" on public.account_verification_events;
create policy "account_verification_events_select_own"
on public.account_verification_events
for select
using (auth.uid() = user_id);
