-- Generalizes project_change_events (created in 20260818231713_production_launch_alignment.sql)
-- so it can also record AI/workspace-agent executions scoped to a meeting that does not belong
-- to any project -- meetings.project_id is nullable, so a meeting-scoped Ask Parfait edit has
-- had nowhere to log an event until now (see lib/execution-corrections.ts's logCorrectionEvent,
-- which already documents this exact gap: "a task/commitment with no project assigned yet simply
-- has no event logged").
--
-- Purely additive and backwards compatible:
--   - project_id becomes nullable, but every existing writer (apply_project_change_proposal,
--     apply_project_person_correction, lib/execution-corrections.ts, lib/project-brain/
--     direct-commitment-edit.ts) already supplies a real project_id on every insert, so no
--     existing row or insert statement is affected.
--   - meeting_id is a new, nullable column with its own FK -- no existing row needs backfilling.
--   - the new check constraint only requires that at least one scope id is present, which every
--     existing row already satisfies (they all have project_id).
--   - no table recreation, no data migration, no change to existing indexes/RPCs.

alter table public.project_change_events
  alter column project_id drop not null;

alter table public.project_change_events
  add column meeting_id uuid references public.meetings (id) on delete cascade;

alter table public.project_change_events
  add constraint project_change_events_scope_check
  check (project_id is not null or meeting_id is not null);

create index project_change_events_meeting_created_idx
on public.project_change_events (meeting_id, created_at desc)
where meeting_id is not null;
