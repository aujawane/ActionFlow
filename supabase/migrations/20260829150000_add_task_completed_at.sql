-- Forward-only. Adds meeting_tasks.completed_at, needed by Task Workspace's new "Mark as
-- completed" action to show "Completed <date>" and to correctly clear on reopen. No equivalent
-- field exists anywhere else on this table (meeting_tasks has no updated_at at all), so this is
-- a genuinely new, additive, nullable column -- no backfill: existing completed rows simply have
-- no completed_at until they're next touched through the task update route, and the UI treats a
-- null completed_at as "completed, but no date on record" rather than guessing one.
alter table public.meeting_tasks
add column if not exists completed_at timestamptz;
