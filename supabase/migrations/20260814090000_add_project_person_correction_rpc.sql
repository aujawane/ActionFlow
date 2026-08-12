-- Atomic, version-checked Project Brain correction for the existing name-based
-- project identity model. This deliberately does not introduce a Person table.

create or replace function public.apply_project_person_correction(
  p_proposal_id uuid,
  p_actor_id uuid,
  p_operation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  proposal_row public.project_change_proposals%rowtype;
  project_row public.projects%rowtype;
  source_name text;
  destination_name text;
  source_key text;
  destination_key text;
  task_ids uuid[];
  commitment_ids uuid[];
  project_participant_ids uuid[];
  commitment_participant_ids uuid[];
  speaker_alias_ids uuid[];
  referenced_count integer;
  matched_count integer;
  participant_row record;
  survivor_id uuid;
  before_value jsonb;
  after_value jsonb;
begin
  select * into proposal_row
  from public.project_change_proposals
  where id = p_proposal_id
  for update;

  if proposal_row.id is null then
    raise exception 'proposal_not_found' using errcode = 'P0002';
  end if;

  select * into project_row
  from public.projects
  where id = proposal_row.project_id
  for update;

  if project_row.owner_id <> p_actor_id then
    raise exception 'project_access_denied' using errcode = '42501';
  end if;
  if proposal_row.status not in ('pending_review', 'approved') then
    raise exception 'proposal_not_applicable' using errcode = '22023';
  end if;
  if project_row.execution_graph_version <> proposal_row.base_graph_version then
    update public.project_change_proposals
    set status = 'superseded'
    where id = proposal_row.id;
    return jsonb_build_object(
      'applied', false,
      'stale', true,
      'currentGraphVersion', project_row.execution_graph_version
    );
  end if;
  if p_operation->>'type' is distinct from 'correct_project_person'
    or jsonb_typeof(p_operation->'affectedReferences') is distinct from 'array'
    or jsonb_array_length(p_operation->'affectedReferences') = 0
  then
    raise exception 'invalid_person_correction' using errcode = '22023';
  end if;

  source_name := btrim(p_operation->>'sourceName');
  destination_name := btrim(p_operation->>'destinationName');
  source_key := lower(source_name);
  destination_key := lower(destination_name);
  if source_name is null or destination_name is null
    or source_name = '' or destination_name = '' or source_key = destination_key
  then
    raise exception 'invalid_person_names' using errcode = '22023';
  end if;

  task_ids := array(
    select distinct (reference->>'id')::uuid
    from jsonb_array_elements(p_operation->'affectedReferences') reference
    where reference->>'type' = 'task'
  );
  commitment_ids := array(
    select distinct (reference->>'id')::uuid
    from jsonb_array_elements(p_operation->'affectedReferences') reference
    where reference->>'type' = 'commitment'
  );
  project_participant_ids := array(
    select distinct (reference->>'id')::uuid
    from jsonb_array_elements(p_operation->'affectedReferences') reference
    where reference->>'type' = 'project_participant'
  );
  commitment_participant_ids := array(
    select distinct (reference->>'id')::uuid
    from jsonb_array_elements(p_operation->'affectedReferences') reference
    where reference->>'type' = 'commitment_participant'
  );
  speaker_alias_ids := array(
    select distinct (reference->>'id')::uuid
    from jsonb_array_elements(p_operation->'affectedReferences') reference
    where reference->>'type' = 'speaker_alias'
  );

  -- Independently prove that the destination already exists somewhere in this
  -- project's supported identity reference model. Never create a new identity.
  if not (
    exists (
      select 1 from public.meeting_tasks task
      where task.project_id = project_row.id and (
        lower(btrim(task.owner)) = destination_key or exists (
          select 1 from jsonb_array_elements_text(coalesce(task.owners, '[]'::jsonb)) value
          where lower(btrim(value)) = destination_key
        )
      )
    ) or exists (
      select 1 from public.meeting_commitments commitment
      where commitment.project_id = project_row.id and (
        lower(btrim(commitment.owner)) = destination_key or
        lower(btrim(commitment.lead_owner_name)) = destination_key or exists (
          select 1 from jsonb_array_elements_text(coalesce(commitment.owners, '[]'::jsonb)) value
          where lower(btrim(value)) = destination_key
        )
      )
    ) or exists (
      select 1 from public.project_participants participant
      where participant.project_id = project_row.id
        and lower(btrim(participant.participant_name)) = destination_key
    ) or exists (
      select 1 from public.commitment_participants participant
      join public.meeting_commitments commitment on commitment.id = participant.commitment_id
      where commitment.project_id = project_row.id
        and lower(btrim(participant.participant_name)) = destination_key
    ) or exists (
      select 1 from public.meeting_speaker_aliases alias
      join public.meetings meeting on meeting.id = alias.meeting_id
      where meeting.project_id = project_row.id
        and lower(btrim(alias.display_name)) = destination_key
    )
  ) then
    raise exception 'destination_person_not_found' using errcode = '22023';
  end if;

  -- Every submitted stable reference must belong to this project and still
  -- contain the reviewed source identity. A changed reference makes the whole
  -- transaction fail rather than partially applying a stale merge.
  referenced_count := cardinality(task_ids);
  select count(*) into matched_count
  from public.meeting_tasks task
  where task.id = any(task_ids) and task.project_id = project_row.id and (
    lower(btrim(task.owner)) = source_key or exists (
      select 1 from jsonb_array_elements_text(coalesce(task.owners, '[]'::jsonb)) value
      where lower(btrim(value)) = source_key
    )
  );
  if matched_count <> referenced_count then
    raise exception 'task_person_reference_changed' using errcode = '40001';
  end if;

  referenced_count := cardinality(commitment_ids);
  select count(*) into matched_count
  from public.meeting_commitments commitment
  where commitment.id = any(commitment_ids) and commitment.project_id = project_row.id and (
    lower(btrim(commitment.owner)) = source_key or
    lower(btrim(commitment.lead_owner_name)) = source_key or exists (
      select 1 from jsonb_array_elements_text(coalesce(commitment.owners, '[]'::jsonb)) value
      where lower(btrim(value)) = source_key
    )
  );
  if matched_count <> referenced_count then
    raise exception 'commitment_person_reference_changed' using errcode = '40001';
  end if;

  referenced_count := cardinality(project_participant_ids);
  select count(*) into matched_count
  from public.project_participants participant
  where participant.id = any(project_participant_ids)
    and participant.project_id = project_row.id
    and lower(btrim(participant.participant_name)) = source_key;
  if matched_count <> referenced_count then
    raise exception 'project_participant_reference_changed' using errcode = '40001';
  end if;

  referenced_count := cardinality(commitment_participant_ids);
  select count(*) into matched_count
  from public.commitment_participants participant
  join public.meeting_commitments commitment on commitment.id = participant.commitment_id
  where participant.id = any(commitment_participant_ids)
    and commitment.project_id = project_row.id
    and lower(btrim(participant.participant_name)) = source_key;
  if matched_count <> referenced_count then
    raise exception 'commitment_participant_reference_changed' using errcode = '40001';
  end if;

  referenced_count := cardinality(speaker_alias_ids);
  select count(*) into matched_count
  from public.meeting_speaker_aliases alias
  join public.meetings meeting on meeting.id = alias.meeting_id
  where alias.id = any(speaker_alias_ids)
    and meeting.project_id = project_row.id
    and lower(btrim(alias.display_name)) = source_key;
  if matched_count <> referenced_count then
    raise exception 'speaker_alias_reference_changed' using errcode = '40001';
  end if;

  before_value := jsonb_build_object(
    'sourceName', source_name,
    'destinationName', destination_name,
    'affectedReferences', p_operation->'affectedReferences'
  );

  update public.meeting_tasks task
  set owner = case when lower(btrim(task.owner)) = source_key then destination_name else task.owner end,
      owners = (
        select coalesce(jsonb_agg(distinct replacement.value), '[]'::jsonb)
        from (
          select case when lower(btrim(value)) = source_key then destination_name else value end as value
          from jsonb_array_elements_text(coalesce(task.owners, '[]'::jsonb)) value
        ) replacement
      ),
      preserve_on_reanalysis = true,
      manual_override_fields = coalesce(task.manual_override_fields, '[]'::jsonb)
        || case when lower(btrim(task.owner)) = source_key then '["owner"]'::jsonb else '[]'::jsonb end
        || case when exists (
          select 1 from jsonb_array_elements_text(coalesce(task.owners, '[]'::jsonb)) value
          where lower(btrim(value)) = source_key
        ) then '["owners"]'::jsonb else '[]'::jsonb end
  where task.id = any(task_ids);

  update public.meeting_commitments commitment
  set owner = case when lower(btrim(commitment.owner)) = source_key then destination_name else commitment.owner end,
      lead_owner_name = case
        when lower(btrim(commitment.lead_owner_name)) = source_key then destination_name
        else commitment.lead_owner_name
      end,
      owners = (
        select coalesce(jsonb_agg(distinct replacement.value), '[]'::jsonb)
        from (
          select case when lower(btrim(value)) = source_key then destination_name else value end as value
          from jsonb_array_elements_text(coalesce(commitment.owners, '[]'::jsonb)) value
        ) replacement
      ),
      preserve_on_reanalysis = true,
      manual_override_fields = coalesce(commitment.manual_override_fields, '[]'::jsonb)
        || case when lower(btrim(commitment.owner)) = source_key then '["owner"]'::jsonb else '[]'::jsonb end
        || case when lower(btrim(commitment.lead_owner_name)) = source_key then '["lead_owner_name"]'::jsonb else '[]'::jsonb end
        || case when exists (
          select 1 from jsonb_array_elements_text(coalesce(commitment.owners, '[]'::jsonb)) value
          where lower(btrim(value)) = source_key
        ) then '["owners"]'::jsonb else '[]'::jsonb end
  where commitment.id = any(commitment_ids);

  -- Merge project participant rows without creating duplicate destination names.
  select id into survivor_id
  from public.project_participants
  where project_id = project_row.id and lower(btrim(participant_name)) = destination_key
  order by created_at asc limit 1;
  if survivor_id is null and cardinality(project_participant_ids) > 0 then
    survivor_id := project_participant_ids[1];
    update public.project_participants
    set participant_name = destination_name, manually_confirmed = true
    where id = survivor_id;
  elsif survivor_id is not null then
    update public.project_participants
    set manually_confirmed = true
    where id = survivor_id;
  end if;
  delete from public.project_participants
  where id = any(project_participant_ids) and id is distinct from survivor_id;

  -- Commitment participants are unique per commitment, so merge independently
  -- within each commitment while preserving the destination row when present.
  for participant_row in
    select participant.id, participant.commitment_id
    from public.commitment_participants participant
    where participant.id = any(commitment_participant_ids)
  loop
    select id into survivor_id
    from public.commitment_participants
    where commitment_id = participant_row.commitment_id
      and lower(btrim(participant_name)) = destination_key
    order by created_at asc limit 1;
    if survivor_id is null then
      update public.commitment_participants
      set participant_name = destination_name
      where id = participant_row.id;
    else
      delete from public.commitment_participants where id = participant_row.id;
    end if;
  end loop;

  update public.meeting_speaker_aliases
  set display_name = destination_name
  where id = any(speaker_alias_ids);

  update public.projects
  set execution_graph_version = execution_graph_version + 1
  where id = project_row.id
  returning execution_graph_version into project_row.execution_graph_version;

  update public.project_change_proposals
  set status = 'applied',
      approved_by = p_actor_id,
      applied_at = timezone('utc', now()),
      resulting_graph_version = project_row.execution_graph_version,
      proposal = jsonb_build_object('operations', jsonb_build_array(p_operation))
  where id = proposal_row.id;

  after_value := jsonb_build_object(
    'sourceName', source_name,
    'destinationName', destination_name,
    'affectedReferenceCount', jsonb_array_length(p_operation->'affectedReferences')
  );
  insert into public.project_change_events (
    project_id, proposal_id, actor_type, actor_id, event_type,
    entity_type, entity_id, before_state, after_state, source_type, source_id
  ) values (
    project_row.id, proposal_row.id, 'user', p_actor_id,
    'correct_project_person', 'project', project_row.id,
    before_value, after_value, 'project_chat', proposal_row.source_message_id
  );
  insert into public.project_change_events (
    project_id, proposal_id, actor_type, actor_id, event_type,
    entity_type, entity_id, before_state, after_state, source_type, source_id
  ) values (
    project_row.id, proposal_row.id, 'user', p_actor_id,
    'proposal_applied', 'project', project_row.id,
    jsonb_build_object('execution_graph_version', proposal_row.base_graph_version),
    jsonb_build_object('execution_graph_version', project_row.execution_graph_version),
    'project_chat', proposal_row.source_message_id
  );

  return jsonb_build_object(
    'applied', true,
    'stale', false,
    'resultingGraphVersion', project_row.execution_graph_version,
    'affectedReferenceCount', jsonb_array_length(p_operation->'affectedReferences')
  );
end;
$$;

comment on function public.apply_project_person_correction(uuid, uuid, jsonb) is
  'Service-role-only atomic Project Brain merge of audited name-based project identity references; does not modify transcript or evidence rows.';

revoke all on function public.apply_project_person_correction(uuid, uuid, jsonb) from public;
revoke all on function public.apply_project_person_correction(uuid, uuid, jsonb) from anon;
revoke all on function public.apply_project_person_correction(uuid, uuid, jsonb) from authenticated;
grant execute on function public.apply_project_person_correction(uuid, uuid, jsonb) to service_role;
