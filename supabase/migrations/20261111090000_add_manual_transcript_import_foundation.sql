-- Historical transcript import, Phase 1: schema foundation only.
--
-- Verified against STAGING (applied there; the live columns were checked afterwards):
-- meetings.meeting_url was text NOT NULL (no default), transcript_segments."timestamp" was
-- timestamptz NOT NULL (no default), and there was no meetings.source or meetings.meeting_date.
-- NOT independently verified against Production: its applied migration history and live schema must
-- be checked (read-only) before this is applied there. This file is pending on Production, and the
-- application code that depends on it must be deployed only AFTER it is applied.
--
-- Additive and constraint-relaxing only. No row is rewritten: existing meetings keep their
-- meeting_url, existing segments keep their timestamp, every existing meeting reads back
-- source = 'recall' through the constant column default, and meeting_date starts null.
--
-- 1. An imported meeting has no join link. NULL is the honest value; a placeholder URL would
--    leak into the UI and the link editor.
alter table public.meetings
  alter column meeting_url drop not null;

-- 2. An imported transcript may carry no absolute time. NULL is the honest value: a placeholder
--    timestamp would be shown to the model as a real time, and identical placeholders would let
--    canonical ordering fall through to the random-UUID tie-break. Imported source order lives in
--    raw_payload.parfait_import.segment_index (see lib/transcript-order.ts), not in a new column.
--    replace_meeting_transcript_segments() already casts (seg->>'timestamp')::timestamptz, which
--    passes NULL through unchanged, so the RPC needs no change.
alter table public.transcript_segments
  alter column "timestamp" drop not null;

-- 3. Where the transcript came from. text + CHECK, matching meetings.platform and the rest of the
--    repository (no new enum type). recall_bot_id cannot answer this: a Recall meeting whose bot
--    creation failed also has a null recall_bot_id.
alter table public.meetings
  add column source text not null default 'recall';

alter table public.meetings
  add constraint meetings_source_check
  check (source in ('recall', 'manual_upload', 'manual_paste'));

-- 4. When the meeting actually happened, for historical imports. Null means "use created_at",
--    which stays the time the Parfait record was created. Date only: no time of day is invented.
alter table public.meetings
  add column meeting_date date;

comment on column public.meetings.source is
  'Transcript ingestion source: recall (bot), manual_upload or manual_paste. Existing rows are recall.';
comment on column public.meetings.meeting_date is
  'Calendar date the meeting occurred, when known and different from created_at (historical imports). Null means use created_at.';
