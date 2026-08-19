\set ON_ERROR_STOP on

-- Schema and preserved-data verification.
select phase6_test.assert_true(
  (select count(*) = 30
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')),
  'final public table count must be 11 legacy + 19 launch tables'
);

select phase6_test.assert_true(
  not exists (
    select expected.name
    from unnest(array[
      'account_verification_events', 'user_integrations', 'projects',
      'meeting_commitments', 'meeting_analysis_jobs', 'meeting_conversation_events',
      'task_dependencies', 'commitment_participants', 'commitment_comments',
      'meeting_comments', 'project_memory', 'project_requirements', 'project_decisions',
      'project_constraints', 'project_participants', 'project_chat_threads',
      'project_chat_messages', 'project_change_proposals', 'project_change_events'
    ]) expected(name)
    where to_regclass('public.' || expected.name) is null
  ),
  'all 19 launch tables must exist'
);

select phase6_test.assert_true(
  (select count(*) = 30
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity),
  'RLS must be enabled on all 30 public tables'
);

select phase6_test.assert_true(
  (select enum_range(null::public.execution_classification)::text[] =
    array['committed','proposed','requirement','future_consideration']),
  'execution_classification enum values must match launch contract exactly'
);

select phase6_test.assert_true(
  exists (select 1 from pg_enum where enumtypid = 'public.meeting_status'::regtype
          and enumlabel = 'transcript_ready'),
  'meeting_status must include transcript_ready'
);

select phase6_test.assert_true(
  (select not attnotnull from pg_attribute
   where attrelid = 'public.meeting_tasks'::regclass and attname = 'topic_id'),
  'meeting_tasks.topic_id must be nullable'
);

select phase6_test.assert_true(
  (select confdeltype = 'n' from pg_constraint
   where conrelid = 'public.meeting_tasks'::regclass
     and conname = 'meeting_tasks_topic_id_fkey'),
  'meeting_tasks topic FK must use ON DELETE SET NULL'
);

select phase6_test.assert_true(
  to_regclass('public.meeting_tasks_dedupe_idx') is null and
  exists (select 1 from pg_class c join pg_index i on i.indexrelid = c.oid
          where c.oid = 'public.meeting_tasks_lookup_idx'::regclass and not i.indisunique),
  'legacy dedupe index must be replaced by nonunique lookup index'
);

select phase6_test.assert_true(
  not exists (
    select name from unnest(array[
      'meetings_project_id_idx', 'meeting_commitments_meeting_id_idx',
      'meeting_commitments_topic_id_idx', 'meeting_commitments_status_idx',
      'meeting_commitments_lookup_idx', 'meeting_commitments_project_status_idx',
      'meeting_commitments_active_project_idx',
      'meeting_commitments_meeting_classification_idx', 'meeting_tasks_lookup_idx',
      'meeting_tasks_commitment_id_idx', 'meeting_tasks_meeting_classification_idx',
      'meeting_tasks_commitment_status_idx',
      'meeting_tasks_project_commitment_position_idx',
      'task_artifacts_task_deliverable_version_idx', 'meeting_analysis_jobs_latest_idx',
      'task_dependencies_prerequisite_idx', 'commitment_comments_commitment_created_idx',
      'commitment_participants_commitment_idx', 'project_requirements_title_idx',
      'project_decisions_title_idx', 'project_constraints_title_idx',
      'project_chat_threads_project_updated_idx', 'project_chat_messages_thread_created_idx',
      'project_change_proposals_project_created_idx',
      'project_change_events_project_created_idx',
      'meeting_conversation_events_meeting_type_idx',
      'meeting_comments_meeting_id_created_at_idx'
    ]) indexes(name)
    where to_regclass('public.' || name) is null
  ),
  'all final execution and Project Brain indexes must exist'
);

select phase6_test.assert_true(
  not exists (
    select 1 from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'public' and not c.convalidated
  ),
  'all public constraints must be validated'
);

select phase6_test.assert_true(
  exists (select 1 from pg_constraint where conrelid = 'public.projects'::regclass
          and contype = 'c' and pg_get_constraintdef(oid) like '%execution_graph_version%') and
  exists (select 1 from pg_constraint where conrelid = 'public.project_change_proposals'::regclass
          and contype = 'f' and confrelid = 'public.projects'::regclass) and
  exists (select 1 from pg_constraint where conrelid = 'public.project_change_events'::regclass
          and contype = 'f' and confrelid = 'public.project_change_proposals'::regclass) and
  exists (select 1 from pg_constraint where conrelid = 'public.task_dependencies'::regclass
          and contype = 'c'),
  'required Project Brain and dependency checks/FKs must exist'
);

-- Existing business data and approved backfills.
select phase6_test.assert_true(
  (select jsonb_agg(jsonb_build_object('id', id, 'full_name', full_name) order by id)
   from public.profiles) =
  '[{"id":"00000000-0000-0000-0000-00000000000a","full_name":"User A"},
    {"id":"00000000-0000-0000-0000-00000000000b","full_name":"User B"}]'::jsonb and
  not exists (select 1 from public.profiles where avatar_url is not null),
  'profiles must be preserved and new avatar_url values must be NULL'
);

select phase6_test.assert_true(
  (select count(*) = 3 from public.meetings) and
  (select count(*) = 1 from public.meetings where deleted_at is not null) and
  not exists (select 1 from public.meetings where project_id is not null) and
  not exists (select 1 from public.meetings
              where execution_graph_generation <> 0 or last_persisted_execution_generation <> 0) and
  (select user_id = '00000000-0000-0000-0000-00000000000a'::uuid
   from public.meetings where id = '10000000-0000-0000-0000-00000000000a'),
  'meetings, ownership, soft deletion, and generation backfill must be preserved'
);

select phase6_test.assert_true(
  (select count(*) = 2 from public.meeting_topics) and
  (select count(*) = 3 from public.meeting_tasks) and
  (select task = 'Prepare launch plan' and owner = 'Alice' and due_date = '2026-09-01'::date
          and workspace_type = 'planning' and workspace_summary = 'Launch plan'
   from public.meeting_tasks where id = '30000000-0000-0000-0000-000000000001') and
  (select owner is null and due_date is null and workspace_type = 'research'
   from public.meeting_tasks where id = '30000000-0000-0000-0000-000000000002'),
  'legacy topics and important task values must be unchanged'
);

select phase6_test.assert_true(
  not exists (
    select 1 from public.meeting_tasks
    where preserve_on_reanalysis is distinct from true
       or manual_override_fields <> '["status","owner","due_date"]'::jsonb
       or owners <> '[]'::jsonb
       or due_date_text is not null
       or source_segment_ids <> '[]'::jsonb
       or inferred
       or extraction_metadata <> '{}'::jsonb
       or conversation_event_ids <> '[]'::jsonb
       or execution_classification <> 'committed'
       or position <> 0
       or commitment_id is not null
       or project_id is not null
  ),
  'legacy task backfill must use exact approved values'
);

select phase6_test.assert_true(
  (select count(*) = 2 from public.task_artifacts) and
  (select content = 'Edited content' and version = 2 and status = 'edited'
   from public.task_artifacts where id = '40000000-0000-0000-0000-000000000002') and
  not exists (select 1 from public.task_artifacts
              where accepted_at is not null or accepted_by is not null) and
  (select count(*) = 1 from public.task_comments
   where id = '50000000-0000-0000-0000-000000000001'
     and message = 'Keep this comment'),
  'artifacts and task comments must be preserved with NULL acceptance fields'
);

select phase6_test.assert_true(
  (select jsonb_agg(to_jsonb(a) order by a.id) from public.meeting_speaker_aliases a) =
    (select aliases from phase6_test.speaker_snapshot) and
  (select jsonb_agg(jsonb_build_object(
    'id', s.id, 'speaker', s.speaker, 'participant_name', s.participant_name,
    'diarized_speaker', s.diarized_speaker, 'speaker_confidence', s.speaker_confidence,
    'resolved_speaker', s.resolved_speaker, 'content', s.content, 'raw_payload', s.raw_payload
  ) order by s.id) from public.transcript_segments s) =
    (select segments from phase6_test.speaker_snapshot),
  'legacy speaker aliases and transcript attribution must be byte-for-value unchanged'
);

select phase6_test.assert_true(
  not exists (
    select 1 from phase6_test.legacy_acl_snapshot snapshot
    join pg_class c on c.relname = snapshot.relname
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relacl::text is distinct from snapshot.relacl
  ),
  'legacy table ACLs must be unchanged'
);

-- Deterministic table ACLs for every new table.
do $$
declare table_name text;
declare role_name text;
declare actual_privileges text[];
begin
  foreach table_name in array array[
    'account_verification_events', 'user_integrations', 'projects',
    'meeting_commitments', 'meeting_analysis_jobs', 'meeting_conversation_events',
    'task_dependencies', 'commitment_participants', 'commitment_comments',
    'meeting_comments', 'project_memory', 'project_requirements', 'project_decisions',
    'project_constraints', 'project_participants', 'project_chat_threads',
    'project_chat_messages', 'project_change_proposals', 'project_change_events'
  ] loop
    if exists (
      select 1 from pg_class c, lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
      where c.oid = ('public.' || table_name)::regclass and acl.grantee = 0
    ) then
      raise exception 'Phase 6 assertion failed: PUBLIC has privileges on %', table_name;
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
      select array_agg(acl.privilege_type order by acl.privilege_type)
      into actual_privileges
      from pg_class c, lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
      where c.oid = ('public.' || table_name)::regclass
        and acl.grantee = (select oid from pg_roles where rolname = role_name);
      if actual_privileges is distinct from array['DELETE','INSERT','SELECT','UPDATE'] then
        raise exception 'Phase 6 assertion failed: % ACL on % is %',
          role_name, table_name, actual_privileges;
      end if;
    end loop;
  end loop;
end;
$$;

-- Function inventory, owner/search_path, SECURITY DEFINER, and EXECUTE ACLs.
select phase6_test.assert_true(
  (select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public') = array[
    'accept_deliverable(uuid,uuid)',
    'apply_project_change_proposal(uuid,uuid,jsonb)',
    'apply_project_change_proposal_with_dependency_provenance(uuid,uuid,jsonb)',
    'apply_project_person_correction(uuid,uuid,jsonb)',
    'assign_meeting_project(uuid,uuid)',
    'can_access_project(uuid)',
    'claim_meeting_analysis_job(uuid)',
    'claim_meeting_execution_analysis(uuid)',
    'create_deliverable_version(uuid,text,text,text,text,text,jsonb)',
    'handle_new_auth_user()',
    'merge_commitment_tasks(uuid,uuid,uuid[])',
    'preserve_converted_commitment()',
    'preserve_manual_commitment_classification()',
    'preserve_manual_task_classification()',
    'preserve_manual_task_parent()',
    'reject_task_dependency_cycle()',
    'reopen_deliverable(uuid)',
    'replace_meeting_conversation_events(uuid,bigint,jsonb)',
    'replace_meeting_execution_graph(uuid,bigint,jsonb,jsonb)',
    'replace_task_dependencies(uuid,uuid[])',
    'set_updated_at()',
    'sync_commitment_lead_owner()',
    'sync_execution_row_project()',
    'task_has_accepted_current_deliverable(uuid)'
  ],
  'final public application function signatures must match exactly'
);

select phase6_test.assert_true(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    where n.nspname = 'public'
      and (r.rolname <> current_user or p.proconfig is distinct from array['search_path=public'])
  ),
  'all public functions must be owned by the migration owner with fixed public search_path'
);

select phase6_test.assert_true(
  (select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef) = array[
    'apply_project_change_proposal(uuid,uuid,jsonb)',
    'apply_project_change_proposal_with_dependency_provenance(uuid,uuid,jsonb)',
    'apply_project_person_correction(uuid,uuid,jsonb)',
    'can_access_project(uuid)',
    'handle_new_auth_user()'
  ],
  'SECURITY DEFINER inventory must match the approved five functions'
);

do $$
declare signature text;
begin
  foreach signature in array array[
    'set_updated_at()', 'handle_new_auth_user()', 'sync_execution_row_project()',
    'preserve_converted_commitment()', 'reject_task_dependency_cycle()',
    'sync_commitment_lead_owner()', 'preserve_manual_task_parent()',
    'preserve_manual_task_classification()',
    'preserve_manual_commitment_classification()'
  ] loop
    if has_function_privilege('anon', ('public.' || signature)::regprocedure, 'EXECUTE')
       or has_function_privilege('authenticated', ('public.' || signature)::regprocedure, 'EXECUTE')
       or has_function_privilege('service_role', ('public.' || signature)::regprocedure, 'EXECUTE') then
      raise exception 'Phase 6 assertion failed: trigger helper % is API-executable', signature;
    end if;
  end loop;

  foreach signature in array array[
    'claim_meeting_analysis_job(uuid)', 'claim_meeting_execution_analysis(uuid)',
    'replace_meeting_execution_graph(uuid,bigint,jsonb,jsonb)',
    'replace_meeting_conversation_events(uuid,bigint,jsonb)',
    'replace_task_dependencies(uuid,uuid[])', 'assign_meeting_project(uuid,uuid)',
    'merge_commitment_tasks(uuid,uuid,uuid[])',
    'task_has_accepted_current_deliverable(uuid)',
    'create_deliverable_version(uuid,text,text,text,text,text,jsonb)',
    'accept_deliverable(uuid,uuid)', 'reopen_deliverable(uuid)',
    'apply_project_change_proposal(uuid,uuid,jsonb)',
    'apply_project_change_proposal_with_dependency_provenance(uuid,uuid,jsonb)',
    'apply_project_person_correction(uuid,uuid,jsonb)'
  ] loop
    if has_function_privilege('anon', ('public.' || signature)::regprocedure, 'EXECUTE')
       or has_function_privilege('authenticated', ('public.' || signature)::regprocedure, 'EXECUTE')
       or not has_function_privilege('service_role', ('public.' || signature)::regprocedure, 'EXECUTE') then
      raise exception 'Phase 6 assertion failed: service-only ACL mismatch for %', signature;
    end if;
  end loop;
end;
$$;

select phase6_test.assert_true(
  not has_function_privilege('anon', 'public.can_access_project(uuid)', 'EXECUTE') and
  has_function_privilege('authenticated', 'public.can_access_project(uuid)', 'EXECUTE') and
  has_function_privilege('service_role', 'public.can_access_project(uuid)', 'EXECUTE') and
  has_function_privilege(current_user, 'public.can_access_project(uuid)', 'EXECUTE'),
  'can_access_project EXECUTE ACL must be authenticated/service_role/owner only'
);

select phase6_test.assert_true(
  not exists (
    select name from unnest(array[
      'user_integrations_set_updated_at', 'projects_set_updated_at',
      'meeting_commitments_set_updated_at', 'meeting_analysis_jobs_set_updated_at',
      'meeting_commitments_sync_project', 'meeting_tasks_sync_project',
      'meeting_tasks_preserve_converted_commitment', 'task_dependencies_reject_cycle',
      'meeting_commitments_sync_lead_owner', 'commitment_participants_set_updated_at',
      'project_memory_set_updated_at', 'project_requirements_set_updated_at',
      'project_decisions_set_updated_at', 'project_constraints_set_updated_at',
      'project_participants_set_updated_at', 'project_chat_threads_set_updated_at',
      'meeting_tasks_preserve_manual_parent',
      'meeting_tasks_preserve_manual_classification',
      'meeting_commitments_preserve_manual_classification'
    ]) expected(name)
    where not exists (select 1 from pg_trigger where tgname = expected.name and not tgisinternal)
  ),
  'all expected launch triggers must exist'
);

-- Constraint behavior: nullable topic, SET NULL, and task status.
insert into public.meeting_topics (id, meeting_id, title)
values ('20000000-0000-0000-0000-000000000099',
        '10000000-0000-0000-0000-00000000000a', 'Disposable topic');
insert into public.meeting_tasks (
  id, meeting_id, topic_id, task, task_type, status, workspace_type
) values (
  '30000000-0000-0000-0000-000000000099',
  '10000000-0000-0000-0000-00000000000a',
  '20000000-0000-0000-0000-000000000099', 'Disposable topic task',
  'unassigned_work', 'blocked', 'other'
);
delete from public.meeting_topics where id = '20000000-0000-0000-0000-000000000099';
select phase6_test.assert_true(
  (select topic_id is null and status = 'blocked' from public.meeting_tasks
   where id = '30000000-0000-0000-0000-000000000099'),
  'topic deletion must preserve the task with NULL topic_id and blocked must be valid'
);
do $$
begin
  begin
    update public.meeting_tasks set status = 'invalid'
    where id = '30000000-0000-0000-0000-000000000099';
    raise exception 'invalid status unexpectedly accepted';
  exception when check_violation then null;
  end;
end;
$$;

-- Projects and representative trigger behavior.
insert into public.projects (id, name, owner_id, updated_at) values
  ('90000000-0000-0000-0000-00000000000a', 'Project A',
   '00000000-0000-0000-0000-00000000000a', '2000-01-01+00'),
  ('90000000-0000-0000-0000-00000000000b', 'Project B',
   '00000000-0000-0000-0000-00000000000b', '2000-01-01+00');
update public.projects set description = 'updated' where id = '90000000-0000-0000-0000-00000000000a';
select phase6_test.assert_true(
  (select updated_at > '2000-01-01+00' from public.projects
   where id = '90000000-0000-0000-0000-00000000000a'),
  'set_updated_at trigger must update timestamps'
);

select public.assign_meeting_project(
  '10000000-0000-0000-0000-00000000000a',
  '90000000-0000-0000-0000-00000000000a'
);
select phase6_test.assert_true(
  (select project_id = '90000000-0000-0000-0000-00000000000a'::uuid
   from public.meetings where id = '10000000-0000-0000-0000-00000000000a') and
  not exists (select 1 from public.meeting_tasks
              where meeting_id = '10000000-0000-0000-0000-00000000000a'
                and project_id is distinct from '90000000-0000-0000-0000-00000000000a'::uuid),
  'assign_meeting_project must update the selected meeting and existing graph rows'
);

insert into public.meeting_commitments (
  id, meeting_id, title, owner, type, project_id
) values (
  '91000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-00000000000a', 'Milestone one', 'Source Person',
  'assignment', '90000000-0000-0000-0000-00000000000b'
), (
  '91000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-00000000000a', 'Milestone two', 'Lead Two',
  'assignment', null
);
select phase6_test.assert_true(
  not exists (select 1 from public.meeting_commitments
              where id in ('91000000-0000-0000-0000-000000000001',
                           '91000000-0000-0000-0000-000000000002')
                and project_id is distinct from '90000000-0000-0000-0000-00000000000a'::uuid) and
  (select lead_owner_name = 'Source Person' from public.meeting_commitments
   where id = '91000000-0000-0000-0000-000000000001'),
  'project sync must reject model-supplied mismatch and lead owner must initialize'
);
update public.meeting_commitments set owner = 'Changed Lead'
where id = '91000000-0000-0000-0000-000000000002';
select phase6_test.assert_true(
  (select lead_owner_name = 'Changed Lead' from public.meeting_commitments
   where id = '91000000-0000-0000-0000-000000000002'),
  'commitment lead-owner synchronization must follow owner changes'
);

insert into public.meeting_tasks (
  id, meeting_id, commitment_id, task, owner, owners, task_type,
  status, workspace_type, project_id
) values
  ('92000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000a',
   '91000000-0000-0000-0000-000000000001', 'Dependency A', 'Source Person',
   '["Source Person"]', 'unassigned_work', 'pending', 'other',
   '90000000-0000-0000-0000-00000000000b'),
  ('92000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000000a',
   '91000000-0000-0000-0000-000000000001', 'Dependency B', 'Destination Person',
   '["Destination Person"]', 'unassigned_work', 'pending', 'other', null),
  ('92000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-00000000000a',
   '91000000-0000-0000-0000-000000000001', 'Dependency C', null,
   '[]', 'unassigned_work', 'pending', 'other', null),
  ('92000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-00000000000a',
   '91000000-0000-0000-0000-000000000002', 'Other milestone task', null,
   '[]', 'unassigned_work', 'pending', 'other', null);

select phase6_test.assert_true(
  not exists (select 1 from public.meeting_tasks
              where id::text like '92000000-%'
                and project_id is distinct from '90000000-0000-0000-0000-00000000000a'::uuid),
  'task project sync trigger must overwrite mismatched or missing project_id'
);

update public.meeting_tasks
set manual_override_fields = '["commitment_id"]'::jsonb
where id = '92000000-0000-0000-0000-000000000003';
update public.meeting_tasks
set commitment_id = '91000000-0000-0000-0000-000000000002'
where id = '92000000-0000-0000-0000-000000000003';
select phase6_test.assert_true(
  (select commitment_id = '91000000-0000-0000-0000-000000000001'::uuid
   from public.meeting_tasks where id = '92000000-0000-0000-0000-000000000003'),
  'manual task parent trigger must preserve reviewed parent'
);

update public.meeting_tasks
set execution_classification = 'future_consideration',
    manual_override_fields = manual_override_fields || '["execution_classification"]'::jsonb
where id = '92000000-0000-0000-0000-000000000003';
update public.meeting_tasks set execution_classification = 'proposed'
where id = '92000000-0000-0000-0000-000000000003';
update public.meeting_commitments
set execution_classification = 'future_consideration',
    manual_override_fields = manual_override_fields || '["execution_classification"]'::jsonb
where id = '91000000-0000-0000-0000-000000000002';
update public.meeting_commitments set execution_classification = 'proposed'
where id = '91000000-0000-0000-0000-000000000002';
select phase6_test.assert_true(
  (select execution_classification = 'future_consideration'
   from public.meeting_tasks where id = '92000000-0000-0000-0000-000000000003') and
  (select execution_classification = 'future_consideration'
   from public.meeting_commitments where id = '91000000-0000-0000-0000-000000000002'),
  'manual task and commitment classification triggers must preserve reviewed values'
);

-- Dependency behavior and atomic replacement.
select public.replace_task_dependencies(
  '92000000-0000-0000-0000-000000000002',
  array['92000000-0000-0000-0000-000000000001'::uuid]
);
select phase6_test.assert_true(
  exists (select 1 from public.task_dependencies
          where task_id = '92000000-0000-0000-0000-000000000002'
            and depends_on_task_id = '92000000-0000-0000-0000-000000000001'),
  'valid same-milestone dependency must succeed'
);
do $$
begin
  begin
    perform public.replace_task_dependencies(
      '92000000-0000-0000-0000-000000000001',
      array['92000000-0000-0000-0000-000000000001'::uuid]);
    raise exception 'self dependency unexpectedly accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.replace_task_dependencies(
      '92000000-0000-0000-0000-000000000001',
      array['92000000-0000-0000-0000-000000000002'::uuid]);
    raise exception 'dependency cycle unexpectedly accepted';
  exception when check_violation then null;
  end;
  begin
    perform public.replace_task_dependencies(
      '92000000-0000-0000-0000-000000000001',
      array['92000000-0000-0000-0000-000000000004'::uuid]);
    raise exception 'cross-milestone dependency unexpectedly accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
select phase6_test.assert_true(
  not exists (select 1 from public.task_dependencies
              where task_id = '92000000-0000-0000-0000-000000000001'),
  'failed dependency replacements must be atomic'
);

-- Execution graph generation safety and protected-field behavior on user B's legacy task.
select phase6_test.assert_true(
  public.claim_meeting_execution_analysis('10000000-0000-0000-0000-00000000000b') = 1 and
  public.claim_meeting_execution_analysis('10000000-0000-0000-0000-00000000000b') = 2,
  'analysis claim must increment generation'
);
do $$
begin
  begin
    perform public.replace_meeting_execution_graph(
      '10000000-0000-0000-0000-00000000000b', 1, '[]'::jsonb, '[]'::jsonb);
    raise exception 'stale generation unexpectedly persisted';
  exception when raise_exception then
    if sqlerrm <> 'stale_analysis_run' then raise; end if;
  end;
end;
$$;

select public.replace_meeting_execution_graph(
  '10000000-0000-0000-0000-00000000000b', 2, '[]'::jsonb,
  '[{
    "existing_id":"30000000-0000-0000-0000-000000000003",
    "client_ref":"legacy-b", "title":"Model rewrite", "owner":"Wrong Owner",
    "owners":["Bob","Reviewer"], "task_type":"implicit_commitment",
    "priority":"high", "suggested_steps":[], "due_date":"2027-01-01",
    "due_date_text":"January 2027", "workspace_type":"email",
    "execution_classification":"proposed", "inferred":true
  }]'::jsonb
);
select phase6_test.assert_true(
  (select task = 'Model rewrite' and owner = 'Bob' and due_date is null
          and owners = '["Bob","Reviewer"]'::jsonb
          and due_date_text = 'January 2027' and execution_classification = 'proposed'
   from public.meeting_tasks where id = '30000000-0000-0000-0000-000000000003') and
  (select last_persisted_execution_generation = 2 from public.meetings
   where id = '10000000-0000-0000-0000-00000000000b') and
  (select execution_graph_generation = 0 from public.meetings
   where id = '10000000-0000-0000-0000-00000000000a'),
  'reanalysis must preserve owner/due_date, enrich new fields, and not modify another user meeting'
);

update public.meeting_tasks
set execution_classification = 'future_consideration',
    manual_override_fields = manual_override_fields || '["execution_classification"]'::jsonb
where id = '30000000-0000-0000-0000-000000000003';
select phase6_test.assert_true(
  public.claim_meeting_execution_analysis('10000000-0000-0000-0000-00000000000b') = 3,
  'next analysis generation must be 3'
);
select public.replace_meeting_execution_graph(
  '10000000-0000-0000-0000-00000000000b', 3, '[]'::jsonb, '[]'::jsonb
);
select phase6_test.assert_true(
  exists (select 1 from public.meeting_tasks
          where id = '30000000-0000-0000-0000-000000000003'
            and execution_classification = 'future_consideration'),
  'protected legacy task and manually protected classification must survive reanalysis deletion/rewrite'
);

-- Project Brain stale, valid, provenance, and rollback tests.
insert into public.project_change_proposals (
  id, project_id, status, summary, base_graph_version, created_by
) values (
  '93000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-00000000000a', 'pending_review', 'Stale', 0,
  '00000000-0000-0000-0000-00000000000a'
);
update public.projects set execution_graph_version = 1
where id = '90000000-0000-0000-0000-00000000000a';
select phase6_test.assert_true(
  (public.apply_project_change_proposal(
    '93000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-00000000000a',
    '[{"type":"update_project","changes":{"name":"Stale mutation"}}]'::jsonb
  )->>'stale')::boolean and
  (select name = 'Project A' from public.projects
   where id = '90000000-0000-0000-0000-00000000000a'),
  'stale proposal must not mutate the project graph'
);

insert into public.project_change_proposals (
  id, project_id, status, summary, base_graph_version, created_by
) values (
  '93000000-0000-0000-0000-000000000002',
  '90000000-0000-0000-0000-00000000000a', 'pending_review', 'Valid', 1,
  '00000000-0000-0000-0000-00000000000a'
);
select phase6_test.assert_true(
  (public.apply_project_change_proposal(
    '93000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-00000000000a',
    '[{"type":"update_project","changes":{"name":"Project A reviewed"}}]'::jsonb
  )->>'applied')::boolean,
  'valid Project Brain proposal must apply'
);
select phase6_test.assert_true(
  (select name = 'Project A reviewed' and execution_graph_version = 2
   from public.projects where id = '90000000-0000-0000-0000-00000000000a') and
  (select status = 'applied' and resulting_graph_version = 2
   from public.project_change_proposals where id = '93000000-0000-0000-0000-000000000002') and
  (select count(*) = 2 from public.project_change_events
   where proposal_id = '93000000-0000-0000-0000-000000000002'),
  'valid proposal must increment graph version and write operation + audit events'
);

insert into public.project_change_proposals (
  id, project_id, status, summary, base_graph_version, created_by
) values (
  '93000000-0000-0000-0000-000000000003',
  '90000000-0000-0000-0000-00000000000a', 'pending_review', 'Rollback', 2,
  '00000000-0000-0000-0000-00000000000a'
);
do $$
begin
  begin
    perform public.apply_project_change_proposal(
      '93000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-00000000000a',
      '[{"type":"update_project","changes":{"name":"Must roll back"}},
        {"type":"unsupported"}]'::jsonb);
    raise exception 'invalid proposal unexpectedly applied';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
select phase6_test.assert_true(
  (select name = 'Project A reviewed' and execution_graph_version = 2
   from public.projects where id = '90000000-0000-0000-0000-00000000000a') and
  (select status = 'pending_review' from public.project_change_proposals
   where id = '93000000-0000-0000-0000-000000000003') and
  not exists (select 1 from public.project_change_events
              where proposal_id = '93000000-0000-0000-0000-000000000003'),
  'invalid Project Brain operation must roll back all partial writes'
);

insert into public.project_change_proposals (
  id, project_id, status, summary, base_graph_version, created_by
) values (
  '93000000-0000-0000-0000-000000000004',
  '90000000-0000-0000-0000-00000000000a', 'pending_review', 'Dependency provenance', 2,
  '00000000-0000-0000-0000-00000000000a'
);
select public.apply_project_change_proposal_with_dependency_provenance(
  '93000000-0000-0000-0000-000000000004',
  '00000000-0000-0000-0000-00000000000a',
  '[{"type":"add_dependency","taskId":"92000000-0000-0000-0000-000000000003",
     "dependsOnTaskId":"92000000-0000-0000-0000-000000000001"}]'::jsonb
);
select phase6_test.assert_true(
  exists (select 1 from public.task_dependencies
          where task_id = '92000000-0000-0000-0000-000000000003'
            and depends_on_task_id = '92000000-0000-0000-0000-000000000001') and
  (select preserve_on_reanalysis and manual_override_fields @> '["dependencies"]'::jsonb
   from public.meeting_tasks where id = '92000000-0000-0000-0000-000000000003') and
  (select execution_graph_version = 3 from public.projects
   where id = '90000000-0000-0000-0000-00000000000a'),
  'dependency wrapper must apply mutation and provenance atomically'
);

insert into public.project_change_proposals (
  id, project_id, status, summary, base_graph_version, created_by
) values (
  '93000000-0000-0000-0000-000000000005',
  '90000000-0000-0000-0000-00000000000a', 'pending_review', 'Wrapper rollback', 3,
  '00000000-0000-0000-0000-00000000000a'
);
do $$
begin
  begin
    perform public.apply_project_change_proposal_with_dependency_provenance(
      '93000000-0000-0000-0000-000000000005',
      '00000000-0000-0000-0000-00000000000a',
      '[{"type":"add_dependency","taskId":"92000000-0000-0000-0000-000000000003",
         "dependsOnTaskId":"92000000-0000-0000-0000-000000000002"},
        {"type":"update_project","changes":{"status":"not_valid"}}]'::jsonb);
    raise exception 'invalid wrapper proposal unexpectedly applied';
  exception when check_violation then null;
  end;
end;
$$;
select phase6_test.assert_true(
  not exists (select 1 from public.task_dependencies
              where task_id = '92000000-0000-0000-0000-000000000003'
                and depends_on_task_id = '92000000-0000-0000-0000-000000000002') and
  (select execution_graph_version = 3 from public.projects
   where id = '90000000-0000-0000-0000-00000000000a') and
  (select status = 'pending_review' from public.project_change_proposals
   where id = '93000000-0000-0000-0000-000000000005'),
  'dependency provenance wrapper failure must roll back dependency and proposal writes'
);

-- Speaker-independent person correction covering all four supported references.
insert into public.project_participants (
  id, project_id, participant_name, source_type, manually_confirmed
) values
  ('94000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-00000000000a',
   'Source Person', 'manual', true),
  ('94000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-00000000000a',
   'Destination Person', 'manual', true);
insert into public.commitment_participants (
  id, commitment_id, participant_name
) values
  ('95000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001',
   'Source Person'),
  ('95000000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000001',
   'Destination Person');
insert into public.project_change_proposals (
  id, project_id, status, summary, base_graph_version, created_by
) values (
  '93000000-0000-0000-0000-000000000006',
  '90000000-0000-0000-0000-00000000000a', 'pending_review', 'Person correction', 3,
  '00000000-0000-0000-0000-00000000000a'
);
select phase6_test.assert_true(
  (public.apply_project_person_correction(
    '93000000-0000-0000-0000-000000000006',
    '00000000-0000-0000-0000-00000000000a',
    '{"type":"correct_project_person","sourceName":"Source Person",
      "destinationName":"Destination Person","affectedReferences":[
        {"type":"task","id":"92000000-0000-0000-0000-000000000001"},
        {"type":"commitment","id":"91000000-0000-0000-0000-000000000001"},
        {"type":"project_participant","id":"94000000-0000-0000-0000-000000000001"},
        {"type":"commitment_participant","id":"95000000-0000-0000-0000-000000000001"}
      ]}'::jsonb
  )->>'applied')::boolean,
  'person correction must accept all four supported reference types'
);
select phase6_test.assert_true(
  (select owner = 'Destination Person' and owners = '["Destination Person"]'::jsonb
          and preserve_on_reanalysis and manual_override_fields @> '["owner","owners"]'::jsonb
   from public.meeting_tasks where id = '92000000-0000-0000-0000-000000000001') and
  (select owner = 'Destination Person' and lead_owner_name = 'Destination Person'
          and preserve_on_reanalysis
   from public.meeting_commitments where id = '91000000-0000-0000-0000-000000000001') and
  not exists (select 1 from public.project_participants
              where id = '94000000-0000-0000-0000-000000000001') and
  not exists (select 1 from public.commitment_participants
              where id = '95000000-0000-0000-0000-000000000001') and
  (select execution_graph_version = 4 from public.projects
   where id = '90000000-0000-0000-0000-00000000000a') and
  (select count(*) = 2 from public.project_change_events
   where proposal_id = '93000000-0000-0000-0000-000000000006'),
  'person correction must update identities/provenance/version and write audit events'
);

-- Invalid type, missing destination, changed reference, and stale version are atomic failures.
insert into public.project_change_proposals (
  id, project_id, status, summary, base_graph_version, created_by
) values
  ('93000000-0000-0000-0000-000000000007', '90000000-0000-0000-0000-00000000000a',
   'pending_review', 'Bad speaker type', 4, '00000000-0000-0000-0000-00000000000a'),
  ('93000000-0000-0000-0000-000000000008', '90000000-0000-0000-0000-00000000000a',
   'pending_review', 'Missing destination', 4, '00000000-0000-0000-0000-00000000000a'),
  ('93000000-0000-0000-0000-000000000009', '90000000-0000-0000-0000-00000000000a',
   'pending_review', 'Changed reference', 4, '00000000-0000-0000-0000-00000000000a'),
  ('93000000-0000-0000-0000-000000000010', '90000000-0000-0000-0000-00000000000a',
   'pending_review', 'Stale person', 3, '00000000-0000-0000-0000-00000000000a');
do $$
begin
  begin
    perform public.apply_project_person_correction(
      '93000000-0000-0000-0000-000000000007',
      '00000000-0000-0000-0000-00000000000a',
      '{"type":"correct_project_person","sourceName":"Destination Person",
        "destinationName":"Source Person","affectedReferences":[
          {"type":"speaker_alias","id":"70000000-0000-0000-0000-000000000001"}]}'::jsonb);
    raise exception 'speaker_alias unexpectedly accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.apply_project_person_correction(
      '93000000-0000-0000-0000-000000000008',
      '00000000-0000-0000-0000-00000000000a',
      '{"type":"correct_project_person","sourceName":"Destination Person",
        "destinationName":"Nobody","affectedReferences":[
          {"type":"task","id":"92000000-0000-0000-0000-000000000001"}]}'::jsonb);
    raise exception 'missing destination unexpectedly accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.apply_project_person_correction(
      '93000000-0000-0000-0000-000000000009',
      '00000000-0000-0000-0000-00000000000a',
      '{"type":"correct_project_person","sourceName":"Source Person",
        "destinationName":"Destination Person","affectedReferences":[
          {"type":"task","id":"92000000-0000-0000-0000-000000000001"}]}'::jsonb);
    raise exception 'changed reference unexpectedly accepted';
  exception when serialization_failure then null;
  end;
end;
$$;
select phase6_test.assert_true(
  (public.apply_project_person_correction(
    '93000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-00000000000a',
    '{"type":"correct_project_person","sourceName":"Destination Person",
      "destinationName":"Source Person","affectedReferences":[
        {"type":"task","id":"92000000-0000-0000-0000-000000000001"}]}'::jsonb
  )->>'stale')::boolean,
  'stale person correction must return stale without graph mutation'
);
select phase6_test.assert_true(
  (select execution_graph_version = 4 from public.projects
   where id = '90000000-0000-0000-0000-00000000000a') and
  (select owner = 'Destination Person' from public.meeting_tasks
   where id = '92000000-0000-0000-0000-000000000001') and
  (select jsonb_agg(to_jsonb(a) order by a.id) from public.meeting_speaker_aliases a) =
    (select aliases from phase6_test.speaker_snapshot) and
  (select jsonb_agg(jsonb_build_object(
    'id', s.id, 'speaker', s.speaker, 'participant_name', s.participant_name,
    'diarized_speaker', s.diarized_speaker, 'speaker_confidence', s.speaker_confidence,
    'resolved_speaker', s.resolved_speaker, 'content', s.content, 'raw_payload', s.raw_payload
  ) order by s.id) from public.transcript_segments s) =
    (select segments from phase6_test.speaker_snapshot),
  'failed/stale person corrections must be atomic and never touch speaker data'
);

select phase6_test.assert_true(
  position('meeting_speaker_aliases' in pg_get_functiondef(
    'public.apply_project_person_correction(uuid,uuid,jsonb)'::regprocedure)) = 0 and
  position('transcript_segments' in pg_get_functiondef(
    'public.apply_project_person_correction(uuid,uuid,jsonb)'::regprocedure)) = 0 and
  position('speaker_alias' in pg_get_functiondef(
    'public.apply_project_person_correction(uuid,uuid,jsonb)'::regprocedure)) = 0,
  'person correction function body must be speaker-independent'
);

-- Multi-type deliverable lifecycle.
select (public.create_deliverable_version(
  '92000000-0000-0000-0000-000000000003', 'document', 'document',
  'Doc v1', 'Document one', 'generated', '{}'
)).id as document_v1 \gset
select (public.create_deliverable_version(
  '92000000-0000-0000-0000-000000000003', 'email', 'email',
  'Email v1', 'Email one', 'generated', '{}'
)).id as email_v1 \gset
select public.accept_deliverable(:'document_v1', '00000000-0000-0000-0000-00000000000a');
select public.accept_deliverable(:'email_v1', '00000000-0000-0000-0000-00000000000a');
select phase6_test.assert_true(
  (select status = 'completed' from public.meeting_tasks
   where id = '92000000-0000-0000-0000-000000000003') and
  (select accepted_at is not null and accepted_by = '00000000-0000-0000-0000-00000000000a'::uuid
   from public.task_artifacts where id = :'document_v1'),
  'accepting deliverables must stamp acceptance and complete the task'
);
select (public.create_deliverable_version(
  '92000000-0000-0000-0000-000000000003', 'document', 'document',
  'Doc v2', 'Document two', 'edited', '{}'
)).id as document_v2 \gset
select phase6_test.assert_true(
  (select version = 2 from public.task_artifacts where id = :'document_v2') and
  (select version = 1 from public.task_artifacts where id = :'email_v1') and
  (select status = 'completed' from public.meeting_tasks
   where id = '92000000-0000-0000-0000-000000000003'),
  'versions must increment per type and superseding one accepted type must not reopen while another remains accepted'
);
select public.accept_deliverable(:'document_v2', '00000000-0000-0000-0000-00000000000a');
select public.reopen_deliverable(:'email_v1');
select phase6_test.assert_true(
  (select status = 'completed' from public.meeting_tasks
   where id = '92000000-0000-0000-0000-000000000003'),
  'reopening one type must not reopen task while another current type remains accepted'
);
select public.reopen_deliverable(:'document_v2');
select phase6_test.assert_true(
  (select status = 'pending' from public.meeting_tasks
   where id = '92000000-0000-0000-0000-000000000003'),
  'task must reopen when no current accepted deliverable remains'
);

-- Structural and behavioral RLS verification with Supabase-style role/JWT simulation.
select phase6_test.assert_true(
  (select count(*) >= 19 from pg_policy p join pg_class c on c.oid = p.polrelid
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in (
     'account_verification_events', 'user_integrations', 'projects',
     'meeting_commitments', 'meeting_analysis_jobs', 'meeting_conversation_events',
     'task_dependencies', 'commitment_participants', 'commitment_comments',
     'meeting_comments', 'project_memory', 'project_requirements', 'project_decisions',
     'project_constraints', 'project_participants', 'project_chat_threads',
     'project_chat_messages', 'project_change_proposals', 'project_change_events'
   )),
  'all new tables must have launch RLS policies'
);

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare visible_projects integer;
declare foreign_projects integer;
begin
  select count(*) into visible_projects from public.projects;
  select count(*) into foreign_projects from public.projects
  where owner_id = '00000000-0000-0000-0000-00000000000b';
  if visible_projects < 1 or foreign_projects <> 0 then
    raise exception 'RLS user A project visibility failed';
  end if;

  insert into public.projects (id, name, owner_id)
  values ('96000000-0000-0000-0000-000000000001', 'RLS own project',
          '00000000-0000-0000-0000-00000000000a');
  update public.projects set description = 'RLS update'
  where id = '96000000-0000-0000-0000-000000000001';

  begin
    insert into public.projects (id, name, owner_id)
    values ('96000000-0000-0000-0000-000000000002', 'RLS foreign project',
            '00000000-0000-0000-0000-00000000000b');
    raise exception 'RLS foreign insert unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set role anon;
reset request.jwt.claim.sub;
do $$
declare visible_projects integer;
begin
  select count(*) into visible_projects from public.projects;
  if visible_projects <> 0 then
    raise exception 'anon gained rows from table-level SELECT';
  end if;
end;
$$;
reset role;

select 'PHASE 6 ALIGNMENT VERIFICATION PASSED' as phase6_result;
