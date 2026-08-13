-- Atomic wrapper: a Project Brain add_dependency/remove_dependency approval and the resulting
-- manual-dependency-provenance marking must succeed or fail together, in one transaction.
--
-- Previously the API route called apply_project_change_proposal, then made a *separate*
-- application-layer update to mark the affected tasks' manual_override_fields/
-- preserve_on_reanalysis. If that second call failed after the first committed, a human-approved
-- add_dependency/remove_dependency decision would exist in task_dependencies (or, for a removal,
-- exist only as an absence) while still reading as AI-unlocked -- later AI dependency inference
-- could then silently overwrite it. This wrapper closes that gap by doing both inside a single
-- Postgres function invocation: if the provenance update fails, Postgres rolls back everything
-- the inner apply_project_change_proposal call already did too, since nothing commits until this
-- function returns.
--
-- The existing ~800-line apply_project_change_proposal function (see
-- 20260727130000_project_brain_phase1.sql) is left completely untouched -- this wrapper only
-- calls it and post-processes its already-validated p_operations input, mirroring exactly how
-- the manual dependency picker's provenance marking works (preserve_on_reanalysis = true,
-- "dependencies" appended to manual_override_fields, idempotently).
create or replace function public.apply_project_change_proposal_with_dependency_provenance(
  p_proposal_id uuid,
  p_actor_id uuid,
  p_operations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
  operation jsonb;
  affected_task_id uuid;
begin
  -- apply_project_change_proposal is all-or-nothing: any invalid/unauthorized operation raises
  -- an exception that aborts this whole function call (and therefore this whole transaction,
  -- including anything below), so by the time it returns without raising, every operation in
  -- p_operations was genuinely applied. The one exception is the version-conflict ("stale")
  -- path, which returns normally without applying anything -- detected and short-circuited below
  -- so no provenance is ever marked for operations that were never actually applied.
  result := public.apply_project_change_proposal(p_proposal_id, p_actor_id, p_operations);

  if coalesce((result->>'stale')::boolean, false) then
    return result;
  end if;

  for operation in select value from jsonb_array_elements(p_operations)
  loop
    if operation->>'type' in ('add_dependency', 'remove_dependency') then
      -- Both an add and a removal are equally meaningful human decisions (a removal's "no
      -- dependency" choice has no row of its own in task_dependencies to point to -- this
      -- manual_override_fields entry is the only durable record of it).
      affected_task_id := (operation->>'taskId')::uuid;
      update public.meeting_tasks
      set preserve_on_reanalysis = true,
          manual_override_fields = case
            when coalesce(manual_override_fields, '[]'::jsonb) @> '["dependencies"]'::jsonb
              then coalesce(manual_override_fields, '[]'::jsonb)
            else coalesce(manual_override_fields, '[]'::jsonb) || '["dependencies"]'::jsonb
          end
      where id = affected_task_id;
    end if;
  end loop;

  return result;
end;
$$;

comment on function public.apply_project_change_proposal_with_dependency_provenance(uuid, uuid, jsonb) is
  'Service-role-only atomic wrapper: applies a Project Brain proposal via apply_project_change_proposal, then marks manual dependency provenance for any approved add_dependency/remove_dependency operations, all in one transaction.';

revoke all on function public.apply_project_change_proposal_with_dependency_provenance(uuid, uuid, jsonb) from public;
revoke all on function public.apply_project_change_proposal_with_dependency_provenance(uuid, uuid, jsonb) from anon;
revoke all on function public.apply_project_change_proposal_with_dependency_provenance(uuid, uuid, jsonb) from authenticated;
grant execute on function public.apply_project_change_proposal_with_dependency_provenance(uuid, uuid, jsonb) to service_role;
