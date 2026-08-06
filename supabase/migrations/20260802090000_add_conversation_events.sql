create table if not exists public.meeting_conversation_events (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  client_ref text not null,
  type text not null check (type in (
    'promise', 'request', 'acceptance', 'assignment', 'decision',
    'progress_update', 'proposal', 'future_idea', 'question', 'reminder',
    'scheduling_agreement', 'blocker', 'completed_work', 'requirement'
  )),
  actors jsonb not null default '[]'::jsonb,
  action text,
  object text,
  temporal_state text not null check (temporal_state in (
    'past', 'present', 'future', 'conditional', 'recurring', 'unspecified'
  )),
  commitment_signal text not null check (commitment_signal in (
    'none', 'proposed', 'requested', 'accepted', 'explicit'
  )),
  source_quote text not null,
  source_segment_ids jsonb not null default '[]'::jsonb,
  linked_event_refs jsonb not null default '[]'::jsonb,
  confidence numeric,
  analysis_generation bigint not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (meeting_id, client_ref)
);

alter table public.meeting_commitments
add column if not exists conversation_event_ids jsonb not null default '[]'::jsonb;

alter table public.meeting_tasks
add column if not exists conversation_event_ids jsonb not null default '[]'::jsonb;

create index if not exists meeting_conversation_events_meeting_type_idx
on public.meeting_conversation_events (meeting_id, type);

alter table public.meeting_conversation_events enable row level security;

drop policy if exists "Users can view their meeting conversation events"
on public.meeting_conversation_events;
create policy "Users can view their meeting conversation events"
on public.meeting_conversation_events for select
using (exists (
  select 1 from public.meetings
  where meetings.id = meeting_conversation_events.meeting_id
    and meetings.user_id = auth.uid()
));

create or replace function public.replace_meeting_conversation_events(
  p_meeting_id uuid,
  p_generation bigint,
  p_events jsonb
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  current_generation bigint;
  event_row jsonb;
  inserted_count integer := 0;
begin
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array' then
    raise exception 'Events must be a JSON array' using errcode = '22023';
  end if;

  select execution_graph_generation into current_generation
  from public.meetings
  where id = p_meeting_id and deleted_at is null
  for update;

  if current_generation is null then
    raise exception 'Meeting does not exist or has been deleted' using errcode = 'P0002';
  end if;
  if current_generation <> p_generation then
    raise exception 'stale_analysis_run' using errcode = 'P0001';
  end if;

  delete from public.meeting_conversation_events where meeting_id = p_meeting_id;
  for event_row in select value from jsonb_array_elements(coalesce(p_events, '[]'::jsonb))
  loop
    insert into public.meeting_conversation_events (
      meeting_id, client_ref, type, actors, action, object, temporal_state,
      commitment_signal, source_quote, source_segment_ids, linked_event_refs,
      confidence, analysis_generation
    ) values (
      p_meeting_id,
      event_row->>'client_ref',
      event_row->>'type',
      coalesce(event_row->'actors', '[]'::jsonb),
      nullif(event_row->>'action', ''),
      nullif(event_row->>'object', ''),
      event_row->>'temporal_state',
      event_row->>'commitment_signal',
      event_row->>'source_quote',
      coalesce(event_row->'source_segment_ids', '[]'::jsonb),
      coalesce(event_row->'linked_event_refs', '[]'::jsonb),
      nullif(event_row->>'confidence', '')::numeric,
      p_generation
    );
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end;
$$;

revoke all on function public.replace_meeting_conversation_events(uuid, bigint, jsonb) from public;
revoke all on function public.replace_meeting_conversation_events(uuid, bigint, jsonb) from anon;
revoke all on function public.replace_meeting_conversation_events(uuid, bigint, jsonb) from authenticated;
grant execute on function public.replace_meeting_conversation_events(uuid, bigint, jsonb) to service_role;
