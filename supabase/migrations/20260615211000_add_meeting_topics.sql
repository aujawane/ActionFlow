create table if not exists public.meeting_topics (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  title text not null,
  summary text,
  start_timestamp text,
  end_timestamp text,
  segment_ids jsonb not null default '[]'::jsonb,
  confidence numeric,
  separation_reason text,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.extracted_insights
add column if not exists topic_id uuid;

alter table public.generated_prompts
add column if not exists topic_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'extracted_insights_topic_id_fkey'
  ) then
    alter table public.extracted_insights
    add constraint extracted_insights_topic_id_fkey
    foreign key (topic_id)
    references public.meeting_topics (id)
    on delete cascade;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'generated_prompts_topic_id_fkey'
  ) then
    alter table public.generated_prompts
    add constraint generated_prompts_topic_id_fkey
    foreign key (topic_id)
    references public.meeting_topics (id)
    on delete cascade;
  end if;
end $$;

create index if not exists meeting_topics_meeting_id_idx on public.meeting_topics (meeting_id);
create index if not exists extracted_insights_topic_id_idx on public.extracted_insights (topic_id);
create index if not exists generated_prompts_topic_id_idx on public.generated_prompts (topic_id);

alter table public.meeting_topics enable row level security;

drop policy if exists "meeting_topics_owner_all" on public.meeting_topics;
create policy "meeting_topics_owner_all"
on public.meeting_topics
for all
using (
  exists (
    select 1
    from public.meetings m
    where m.id = meeting_topics.meeting_id
      and m.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.meetings m
    where m.id = meeting_topics.meeting_id
      and m.user_id = auth.uid()
  )
);
