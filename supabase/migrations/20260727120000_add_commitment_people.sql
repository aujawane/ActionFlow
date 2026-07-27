-- Conversation-level commitments have one lead and an explicit, re-analysis-safe
-- set of manually curated participants. Task owners remain the source of truth
-- for automatically derived "people involved".

alter table public.meeting_commitments
add column if not exists lead_owner_id uuid references auth.users (id) on delete set null,
add column if not exists lead_owner_name text;

update public.meeting_commitments
set lead_owner_name = owner
where lead_owner_name is null
  and owner is not null;

create or replace function public.sync_commitment_lead_owner()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.lead_owner_name := coalesce(new.lead_owner_name, new.owner);
  elsif new.owner is distinct from old.owner
    and not coalesce(new.manual_override_fields, '[]'::jsonb) @> '["lead_owner_name"]'::jsonb
  then
    new.lead_owner_name := new.owner;
  end if;
  return new;
end;
$$;

drop trigger if exists meeting_commitments_sync_lead_owner
on public.meeting_commitments;
create trigger meeting_commitments_sync_lead_owner
before insert or update of owner on public.meeting_commitments
for each row execute procedure public.sync_commitment_lead_owner();

create table if not exists public.commitment_participants (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null
    references public.meeting_commitments (id) on delete cascade,
  participant_user_id uuid references auth.users (id) on delete set null,
  participant_name text not null check (length(trim(participant_name)) > 0),
  involvement_role text not null default 'participant'
    check (involvement_role in ('participant', 'reviewer', 'approver', 'input_provider')),
  manually_added boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (commitment_id, participant_name)
);

create index if not exists commitment_participants_commitment_idx
on public.commitment_participants (commitment_id, created_at);

drop trigger if exists commitment_participants_set_updated_at
on public.commitment_participants;
create trigger commitment_participants_set_updated_at
before update on public.commitment_participants
for each row execute procedure public.set_updated_at();

alter table public.commitment_participants enable row level security;

drop policy if exists "commitment_participants_owner_all"
on public.commitment_participants;
create policy "commitment_participants_owner_all"
on public.commitment_participants
for all
using (
  exists (
    select 1
    from public.meeting_commitments commitment
    join public.meetings meeting on meeting.id = commitment.meeting_id
    where commitment.id = commitment_participants.commitment_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
)
with check (
  exists (
    select 1
    from public.meeting_commitments commitment
    join public.meetings meeting on meeting.id = commitment.meeting_id
    where commitment.id = commitment_participants.commitment_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
);

comment on table public.commitment_participants is
  'Explicit commitment participants. Rows are independent from graph replacement, so manual additions survive re-analysis while task owners are derived at read time.';
