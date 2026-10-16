-- Minimal LOCAL scratch baseline only, not a staging migration.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
end $$;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
create type public.meeting_status as enum ('pending');
create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  execution_graph_generation bigint not null default 0,
  deleted_at timestamptz
);
create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant all on public.meetings to service_role;
