-- Meeting-level "Ask Parfait" conversation persistence.
--
-- Audit finding: task_comments and commitment_comments both exist, but each is foreign-keyed to
-- its owning task/commitment specifically (task_id/commitment_id), not to a meeting. Neither can
-- represent a conversation scoped to an entire meeting -- there is no existing table a meeting-
-- level assistant could safely reuse without conflating unrelated task/commitment threads. This
-- is a genuinely new capability, so a small forward migration is required; it is not a substitute
-- for or a change to either existing table.
--
-- Shape is intentionally identical to commitment_comments (id, owning-entity id, user_id, role,
-- message, metadata, created_at) -- metadata carries the structured response type (answer /
-- generated_content / clarification / declined_mutation) and any generated-content/source
-- references the UI renders, mirroring task_comments.metadata's existing use for structured
-- assistant output.
create table if not exists public.meeting_comments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'system')),
  message text not null check (length(trim(message)) > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists meeting_comments_meeting_id_created_at_idx
on public.meeting_comments (meeting_id, created_at);

alter table public.meeting_comments enable row level security;

-- Scoped to user + meeting via meetings.user_id, exactly like task_comments/commitment_comments
-- scope through their own owning entity -- a meeting has exactly one owning user in this schema,
-- so "scoped to user + meeting" and "scoped to meeting" are the same constraint here.
drop policy if exists "meeting_comments_owner_select" on public.meeting_comments;
create policy "meeting_comments_owner_select"
on public.meeting_comments
for select
using (
  exists (
    select 1
    from public.meetings meeting
    where meeting.id = meeting_comments.meeting_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
);

drop policy if exists "meeting_comments_owner_insert" on public.meeting_comments;
create policy "meeting_comments_owner_insert"
on public.meeting_comments
for insert
with check (
  role = 'user'
  and user_id = auth.uid()
  and exists (
    select 1
    from public.meetings meeting
    where meeting.id = meeting_comments.meeting_id
      and meeting.user_id = auth.uid()
      and meeting.deleted_at is null
  )
);
