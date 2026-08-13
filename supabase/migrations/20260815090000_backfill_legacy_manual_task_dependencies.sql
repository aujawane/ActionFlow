-- Backfill: pre-existing task_dependencies rows predate AI dependency inference and must not be
-- silently treated as AI-authored.
--
-- Audit finding (see accompanying report): before AI dependency inference existed, every
-- task_dependencies row was written by one of exactly two human-facing, human-approved paths --
-- the manual dependency picker (PUT /api/tasks/[id]/dependencies -> replace_task_dependencies)
-- and Project Brain's reviewed add_dependency/remove_dependency proposal operations
-- (apply_project_change_proposal, see 20260727130000_project_brain_phase1.sql). Neither
-- historically recorded provenance on meeting_tasks.manual_override_fields, which AI dependency
-- inference now reads to decide whether a task's dependency selection is safe to recompute
-- (missing => treated as AI-controlled/unlocked). Execution Intelligence V4 / extraction has
-- never written task_dependencies. AI dependency inference has never run against production data
-- before this deployment, so every row present as of this migration is, without ambiguity, a
-- pre-existing human decision.
--
-- Scope: only tasks that currently own at least one task_dependencies row (as task_id) are
-- touched -- their dependency decision is unambiguous. A task with zero rows is deliberately left
-- alone: it may represent a genuine "No dependency" choice made before this feature existed, but
-- that state is indistinguishable from "never considered" with the pre-feature schema, and
-- locking every dependency-less task on a guess would neuter AI inference almost entirely. This
-- mirrors the same conservative choice already documented for meetings_tasks generally.
--
-- Only meeting_tasks.preserve_on_reanalysis/manual_override_fields are touched. No
-- task_dependencies row is read, inserted, updated, or deleted by this migration.
--
-- Idempotent: the where clause skips tasks already marked, so re-running this migration is a
-- no-op the second time.
--
-- Rollback: not a schema change, so there is no DDL to reverse. To undo the marking for exactly
-- this same task set (assuming no further manual dependency edits happened since), re-run the
-- identical `select distinct task_id from task_dependencies` and remove "dependencies" from each
-- task's manual_override_fields. This is intentionally not scripted here -- reversing a
-- provenance-safety backfill is not expected to be a normal operation.
update public.meeting_tasks
set preserve_on_reanalysis = true,
    manual_override_fields = coalesce(manual_override_fields, '[]'::jsonb)
      || '["dependencies"]'::jsonb
where id in (
  select distinct task_id from public.task_dependencies
)
and not (
  coalesce(manual_override_fields, '[]'::jsonb) @> '["dependencies"]'::jsonb
);
