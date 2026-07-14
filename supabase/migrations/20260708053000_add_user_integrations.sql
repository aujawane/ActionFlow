create table if not exists public.user_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  scope text,
  provider_account_email text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, provider)
);

create index if not exists user_integrations_user_id_idx
on public.user_integrations (user_id);

drop trigger if exists user_integrations_set_updated_at on public.user_integrations;
create trigger user_integrations_set_updated_at
before update on public.user_integrations
for each row execute procedure public.set_updated_at();

alter table public.user_integrations enable row level security;

drop policy if exists "user_integrations_owner_select" on public.user_integrations;
create policy "user_integrations_owner_select"
on public.user_integrations
for select
using (user_id = auth.uid());

drop policy if exists "user_integrations_owner_insert" on public.user_integrations;
create policy "user_integrations_owner_insert"
on public.user_integrations
for insert
with check (user_id = auth.uid());

drop policy if exists "user_integrations_owner_update" on public.user_integrations;
create policy "user_integrations_owner_update"
on public.user_integrations
for update
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "user_integrations_owner_delete" on public.user_integrations;
create policy "user_integrations_owner_delete"
on public.user_integrations
for delete
using (user_id = auth.uid());
