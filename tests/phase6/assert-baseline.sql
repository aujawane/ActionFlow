\set ON_ERROR_STOP on

create schema phase6_test;

create function phase6_test.assert_true(condition boolean, message text)
returns void
language plpgsql
as $$
begin
  if condition is not true then
    raise exception 'Phase 6 assertion failed: %', message;
  end if;
end;
$$;

select phase6_test.assert_true(
  (select count(*) = 11
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')),
  'baseline must have exactly 11 public tables'
);

select phase6_test.assert_true(
  not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name in (
      'account_verification_events', 'user_integrations', 'projects',
      'meeting_commitments', 'meeting_analysis_jobs', 'meeting_conversation_events',
      'task_dependencies', 'commitment_participants', 'commitment_comments',
      'meeting_comments', 'project_memory', 'project_requirements', 'project_decisions',
      'project_constraints', 'project_participants', 'project_chat_threads',
      'project_chat_messages', 'project_change_proposals', 'project_change_events'
    )
  ),
  'launch tables must be absent'
);

select phase6_test.assert_true(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and (
      (table_name = 'profiles' and column_name = 'avatar_url') or
      (table_name = 'meetings' and column_name in (
        'project_id', 'execution_graph_generation', 'last_persisted_execution_generation'
      )) or
      (table_name = 'meeting_tasks' and column_name in (
        'commitment_id', 'owners', 'due_date_text', 'source_segment_ids', 'inferred',
        'extraction_metadata', 'preserve_on_reanalysis', 'manual_override_fields',
        'execution_classification', 'project_id', 'position', 'conversation_event_ids'
      )) or
      (table_name = 'task_artifacts' and column_name in ('accepted_at', 'accepted_by'))
    )
  ),
  'alignment columns must be absent'
);

select phase6_test.assert_true(
  to_regtype('public.execution_classification') is null,
  'execution_classification must be absent'
);

select phase6_test.assert_true(
  not exists (
    select 1 from pg_enum e
    where e.enumtypid = 'public.meeting_status'::regtype and e.enumlabel = 'transcript_ready'
  ),
  'transcript_ready must be absent'
);

select phase6_test.assert_true(
  (select array_agg(a.attname order by a.attnum) = array[
    'id', 'meeting_id', 'topic_id', 'task', 'owner', 'task_type', 'priority',
    'suggested_steps', 'source_quote', 'confidence', 'status', 'created_at',
    'workspace_type', 'workspace_summary', 'due_date', 'rationale',
    'supporting_context', 'categorization_metadata'
  ]::name[]
   from pg_attribute a
   where a.attrelid = 'public.meeting_tasks'::regclass
     and a.attnum > 0 and not a.attisdropped),
  'legacy meeting_tasks column list must match the audit'
);

select phase6_test.assert_true(
  (select attnotnull from pg_attribute
   where attrelid = 'public.meeting_tasks'::regclass and attname = 'topic_id'),
  'legacy topic_id must be NOT NULL'
);

select phase6_test.assert_true(
  (select confdeltype = 'c' from pg_constraint
   where conrelid = 'public.meeting_tasks'::regclass
     and conname = 'meeting_tasks_topic_id_fkey' and contype = 'f'),
  'legacy topic FK must cascade'
);

select phase6_test.assert_true(
  exists (select 1 from pg_constraint
          where conrelid = 'public.meeting_tasks'::regclass
            and conname = 'meeting_tasks_status_check' and contype = 'c'),
  'legacy status check must exist'
);

select phase6_test.assert_true(
  exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
          where i.indrelid = 'public.meeting_tasks'::regclass
            and c.relname = 'meeting_tasks_dedupe_idx' and i.indisunique),
  'legacy unique dedupe index must exist'
);

select phase6_test.assert_true(
  (select count(*) = 11 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity),
  'RLS must be enabled on all legacy tables'
);

select phase6_test.assert_true(
  (select count(*) = 3 from public.meetings) and
  (select count(*) = 1 from public.meetings where deleted_at is not null) and
  (select count(*) = 3 from public.meeting_tasks) and
  (select count(*) = 2 from public.task_artifacts) and
  (select count(*) = 1 from public.task_comments) and
  (select count(*) = 2 from public.transcript_segments) and
  (select count(*) = 1 from public.meeting_speaker_aliases),
  'representative baseline row counts must match'
);

select phase6_test.assert_true(
  not exists (select 1 from public.meeting_tasks where status <> 'pending' or topic_id is null),
  'all legacy tasks must be pending with topics'
);

create table phase6_test.legacy_acl_snapshot as
select c.relname, c.relacl::text as relacl
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p');

create table phase6_test.speaker_snapshot as
select
  (select jsonb_agg(to_jsonb(a) order by a.id) from public.meeting_speaker_aliases a) aliases,
  (select jsonb_agg(jsonb_build_object(
    'id', s.id, 'speaker', s.speaker, 'participant_name', s.participant_name,
    'diarized_speaker', s.diarized_speaker, 'speaker_confidence', s.speaker_confidence,
    'resolved_speaker', s.resolved_speaker, 'content', s.content, 'raw_payload', s.raw_payload
  ) order by s.id) from public.transcript_segments s) segments;

select 'BASELINE ASSERTIONS PASSED' as phase6_result;
