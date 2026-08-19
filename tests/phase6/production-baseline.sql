\set ON_ERROR_STOP on

create schema extensions;
create extension pgcrypto with schema extensions;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;

create function auth.uid()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create type public.meeting_status as enum (
  'pending',
  'joining',
  'recording',
  'in_progress',
  'processing',
  'completed',
  'failed'
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text,
  meeting_url text not null,
  recall_bot_id text unique,
  status public.meeting_status not null default 'pending',
  platform text not null default 'google_meet'
    check (platform in ('google_meet', 'zoom', 'unknown')),
  is_pinned boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  speaker text,
  participant_name text,
  diarized_speaker text,
  speaker_confidence numeric,
  resolved_speaker text,
  content text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.extracted_insights (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  topic_id uuid,
  category text not null,
  content text not null,
  confidence numeric(3,2),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.generated_prompts (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  topic_id uuid,
  target_tool text not null,
  prompt text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.meeting_topics (
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
  add constraint extracted_insights_topic_id_fkey
  foreign key (topic_id) references public.meeting_topics (id) on delete cascade;

alter table public.generated_prompts
  add constraint generated_prompts_topic_id_fkey
  foreign key (topic_id) references public.meeting_topics (id) on delete cascade;

create table public.meeting_tasks (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  topic_id uuid not null,
  task text not null,
  owner text,
  task_type text not null check (
    task_type in ('commitment', 'implicit_commitment', 'unassigned_work')
  ),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  suggested_steps jsonb not null default '[]'::jsonb,
  source_quote text,
  confidence numeric,
  status text not null default 'pending',
  created_at timestamptz not null default timezone('utc', now()),
  workspace_type text not null default 'other',
  workspace_summary text,
  due_date date,
  rationale text,
  supporting_context text,
  categorization_metadata jsonb not null default '{}'::jsonb,
  constraint meeting_tasks_topic_id_fkey
    foreign key (topic_id) references public.meeting_topics (id) on delete cascade,
  constraint meeting_tasks_status_check
    check (status in ('pending', 'in_progress', 'completed', 'dismissed')),
  constraint meeting_tasks_workspace_type_check check (
    workspace_type in (
      'research', 'email', 'proposal', 'coding', 'documentation', 'design',
      'meeting_follow_up', 'planning', 'testing', 'decision', 'learning', 'other',
      'website_change', 'scheduling', 'follow_up', 'analysis', 'document'
    )
  )
);

create unique index meeting_tasks_dedupe_idx
on public.meeting_tasks (meeting_id, topic_id, task_type, lower(task));

create table public.task_artifacts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.meeting_tasks (id) on delete cascade,
  artifact_type text not null,
  title text not null,
  content text not null,
  version integer not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deliverable_type text,
  status text not null default 'generated',
  metadata jsonb not null default '{}'::jsonb,
  constraint task_artifacts_status_check check (status in ('generated', 'edited', 'failed'))
);

create table public.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.meeting_tasks (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'system')),
  message text not null check (length(trim(message)) > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table public.meeting_speaker_aliases (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  raw_speaker_label text not null,
  display_name text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (meeting_id, raw_speaker_label)
);

create table public.meeting_artifacts (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  artifact_type text not null,
  title text not null,
  content text,
  status text not null default 'generated',
  metadata jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint meeting_artifacts_status_check check (status in ('generated', 'edited', 'failed'))
);

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_auth_user();

create trigger profiles_set_updated_at before update on public.profiles
for each row execute procedure public.set_updated_at();
create trigger meetings_set_updated_at before update on public.meetings
for each row execute procedure public.set_updated_at();
create trigger transcript_segments_set_updated_at before update on public.transcript_segments
for each row execute procedure public.set_updated_at();
create trigger extracted_insights_set_updated_at before update on public.extracted_insights
for each row execute procedure public.set_updated_at();
create trigger generated_prompts_set_updated_at before update on public.generated_prompts
for each row execute procedure public.set_updated_at();
create trigger task_artifacts_set_updated_at before update on public.task_artifacts
for each row execute procedure public.set_updated_at();
create trigger meeting_speaker_aliases_set_updated_at before update on public.meeting_speaker_aliases
for each row execute procedure public.set_updated_at();
create trigger meeting_artifacts_set_updated_at before update on public.meeting_artifacts
for each row execute procedure public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.meetings enable row level security;
alter table public.transcript_segments enable row level security;
alter table public.extracted_insights enable row level security;
alter table public.generated_prompts enable row level security;
alter table public.meeting_topics enable row level security;
alter table public.meeting_tasks enable row level security;
alter table public.task_artifacts enable row level security;
alter table public.task_comments enable row level security;
alter table public.meeting_speaker_aliases enable row level security;
alter table public.meeting_artifacts enable row level security;

create policy profiles_owner_all on public.profiles for all
using (auth.uid() = id) with check (auth.uid() = id);
create policy meetings_owner_all on public.meetings for all
using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy transcript_segments_owner_all on public.transcript_segments for all
using (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()))
with check (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()));
create policy extracted_insights_owner_all on public.extracted_insights for all
using (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()))
with check (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()));
create policy generated_prompts_owner_all on public.generated_prompts for all
using (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()))
with check (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()));
create policy meeting_topics_owner_all on public.meeting_topics for all
using (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()))
with check (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()));
create policy meeting_tasks_owner_all on public.meeting_tasks for all
using (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()))
with check (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()));
create policy task_artifacts_owner_all on public.task_artifacts for all
using (exists (
  select 1 from public.meeting_tasks t join public.meetings m on m.id = t.meeting_id
  where t.id = task_id and m.user_id = auth.uid()
)) with check (exists (
  select 1 from public.meeting_tasks t join public.meetings m on m.id = t.meeting_id
  where t.id = task_id and m.user_id = auth.uid()
));
create policy task_comments_owner_all on public.task_comments for all
using (exists (
  select 1 from public.meeting_tasks t join public.meetings m on m.id = t.meeting_id
  where t.id = task_id and m.user_id = auth.uid()
)) with check (exists (
  select 1 from public.meeting_tasks t join public.meetings m on m.id = t.meeting_id
  where t.id = task_id and m.user_id = auth.uid()
));
create policy meeting_speaker_aliases_owner_all on public.meeting_speaker_aliases for all
using (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()))
with check (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()));
create policy meeting_artifacts_owner_all on public.meeting_artifacts for all
using (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()))
with check (exists (select 1 from public.meetings m where m.id = meeting_id and m.user_id = auth.uid()));

grant select, insert, update, delete, truncate, references, trigger
on all tables in schema public to anon, authenticated, service_role;

insert into auth.users (id, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', '{"full_name":"User A"}'),
  ('00000000-0000-0000-0000-00000000000b', '{"full_name":"User B"}');

update public.profiles set full_name = 'User A' where id = '00000000-0000-0000-0000-00000000000a';
update public.profiles set full_name = 'User B' where id = '00000000-0000-0000-0000-00000000000b';

insert into public.meetings (
  id, user_id, title, meeting_url, recall_bot_id, status, platform, is_pinned, deleted_at
) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a',
   'User A active', 'https://meet.example/a', 'bot-a', 'completed', 'google_meet', true, null),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b',
   'User B active', 'https://meet.example/b', 'bot-b', 'completed', 'zoom', false, null),
  ('10000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000a',
   'User A deleted', 'https://meet.example/deleted', 'bot-deleted', 'completed', 'unknown', false,
   '2026-08-01 12:00:00+00');

insert into public.meeting_topics (id, meeting_id, title, summary) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'Launch', 'Launch work'),
  ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'Other', 'Other work');

insert into public.meeting_tasks (
  id, meeting_id, topic_id, task, owner, task_type, priority, suggested_steps,
  source_quote, confidence, status, workspace_type, workspace_summary, due_date,
  rationale, supporting_context, categorization_metadata
) values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000a',
   '20000000-0000-0000-0000-00000000000a', 'Prepare launch plan', 'Alice', 'commitment', 'high',
   '["Draft"]', 'Alice will prepare it', 0.95, 'pending', 'planning', 'Launch plan', '2026-09-01',
   'Accepted commitment', 'Launch discussion', '{"legacy":true}'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000000a',
   '20000000-0000-0000-0000-00000000000a', 'Research vendor', null, 'unassigned_work', 'medium',
   '[]', 'Research vendors', 0.80, 'pending', 'research', null, null,
   null, null, '{}'),
  ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-00000000000b',
   '20000000-0000-0000-0000-00000000000b', 'Send follow up', 'Bob', 'implicit_commitment', 'low',
   '["Email"]', 'Bob can send it', 0.70, 'pending', 'email', 'Customer follow-up', null,
   'Expected follow-up', 'Customer discussion', '{}');

insert into public.task_artifacts (
  id, task_id, artifact_type, title, content, version, deliverable_type, status, metadata
) values
  ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
   'document', 'Plan v1', 'Original generated content', 1, 'document', 'generated', '{"source":"legacy"}'),
  ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001',
   'document', 'Plan v2', 'Edited content', 2, 'document', 'edited', '{"source":"legacy"}');

insert into public.task_comments (id, task_id, user_id, role, message, metadata) values
  ('50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-00000000000a', 'user', 'Keep this comment', '{"legacy":true}');

insert into public.transcript_segments (
  id, meeting_id, speaker, participant_name, diarized_speaker, speaker_confidence,
  resolved_speaker, content, started_at, ended_at, raw_payload
) values
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000a',
   'Speaker 0', 'Alice', 'SPEAKER_00', 0.91, 'Alice', 'We should prepare the launch plan.',
   '2026-07-01 12:00:00+00', '2026-07-01 12:00:05+00', '{"speaker":"Speaker 0"}'),
  ('60000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000000b',
   'Speaker 1', 'Bob', 'SPEAKER_01', 0.88, 'Bob', 'I will send the follow up.',
   '2026-07-02 12:00:00+00', '2026-07-02 12:00:05+00', '{"speaker":"Speaker 1"}');

insert into public.meeting_speaker_aliases (
  id, meeting_id, raw_speaker_label, display_name
) values (
  '70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000a',
  'SPEAKER_00', 'Alice'
);

insert into public.meeting_artifacts (
  id, meeting_id, artifact_type, title, content, status, metadata, version
) values (
  '80000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000a',
  'follow_up_email_team_summary', 'Follow-up', 'Legacy meeting artifact', 'generated', '{}', 1
);

insert into public.extracted_insights (meeting_id, topic_id, category, content, confidence)
values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
        'next_steps', 'Prepare launch plan', 0.95);

insert into public.generated_prompts (meeting_id, topic_id, target_tool, prompt)
values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
        'codex', 'Prepare the launch plan');
