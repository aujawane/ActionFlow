-- Phase 6 (trust/correction) gap fix.
--
-- replace_meeting_execution_graph already guards most user-edited columns from being
-- silently overwritten during reanalysis via the `manual_override_fields ? 'field'` case
-- pattern (title, owner, status, due_date, etc.). It does NOT guard execution_classification --
-- that column is unconditionally set to whatever the new analysis run produced. Meeting_tasks
-- already has an equivalent, narrower protection for commitment_id via the
-- preserve_manual_task_parent trigger (see 20260727130000_project_brain_phase1.sql). This
-- migration applies the identical, already-established pattern to execution_classification on
-- both meeting_tasks and meeting_commitments, so a user's manual "Move to Future Scope" /
-- "Promote to active work" correction survives the next reanalysis the same way a manual
-- commitment_id move already does.
--
-- The trigger only reverts a change when manual_override_fields itself is untouched by the same
-- UPDATE statement -- a reanalysis run's blind overwrite never also extends
-- manual_override_fields, while a legitimate manual correction (via the API routes added in
-- this phase) always adds 'execution_classification' to manual_override_fields in the same
-- statement, so its own change is never reverted.

create or replace function public.preserve_manual_task_classification()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.manual_override_fields ? 'execution_classification'
    and new.execution_classification is distinct from old.execution_classification
    and new.manual_override_fields = old.manual_override_fields
  then
    new.execution_classification := old.execution_classification;
  end if;
  return new;
end;
$$;

drop trigger if exists meeting_tasks_preserve_manual_classification
on public.meeting_tasks;
create trigger meeting_tasks_preserve_manual_classification
before update of execution_classification on public.meeting_tasks
for each row execute procedure public.preserve_manual_task_classification();

create or replace function public.preserve_manual_commitment_classification()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.manual_override_fields ? 'execution_classification'
    and new.execution_classification is distinct from old.execution_classification
    and new.manual_override_fields = old.manual_override_fields
  then
    new.execution_classification := old.execution_classification;
  end if;
  return new;
end;
$$;

drop trigger if exists meeting_commitments_preserve_manual_classification
on public.meeting_commitments;
create trigger meeting_commitments_preserve_manual_classification
before update of execution_classification on public.meeting_commitments
for each row execute procedure public.preserve_manual_commitment_classification();
