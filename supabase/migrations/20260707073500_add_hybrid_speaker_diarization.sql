alter table public.transcript_segments
add column if not exists participant_name text,
add column if not exists diarized_speaker text,
add column if not exists speaker_confidence numeric;

create table if not exists public.meeting_speaker_aliases (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  raw_speaker_label text not null,
  display_name text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (meeting_id, raw_speaker_label)
);

create index if not exists meeting_speaker_aliases_meeting_id_idx
on public.meeting_speaker_aliases (meeting_id);

drop trigger if exists meeting_speaker_aliases_set_updated_at on public.meeting_speaker_aliases;
create trigger meeting_speaker_aliases_set_updated_at
before update on public.meeting_speaker_aliases
for each row execute procedure public.set_updated_at();

alter table public.meeting_speaker_aliases enable row level security;

drop policy if exists "meeting_speaker_aliases_owner_all" on public.meeting_speaker_aliases;
create policy "meeting_speaker_aliases_owner_all"
on public.meeting_speaker_aliases
for all
using (
  exists (
    select 1
    from public.meetings m
    where m.id = meeting_speaker_aliases.meeting_id
      and m.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.meetings m
    where m.id = meeting_speaker_aliases.meeting_id
      and m.user_id = auth.uid()
  )
);
