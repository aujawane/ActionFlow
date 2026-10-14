-- Production incident fix: transcript.done and recording.done are two distinct Recall webhook
-- deliveries describing the same completed artifact. Both independently dispatched a transcript
-- import workflow run; the only existing guard (meetings.status, read-then-conditionally-acted-on)
-- is not atomic, and the two concurrent delete+insert pairs against transcript_segments interleaved
-- into double-counted rows. See the incident audit for the full trace.
--
-- Two additive changes, both backwards compatible:
--
-- 1. meetings.transcript_import_claimed_at: a narrow, purpose-built atomic claim for "automatic
--    Recall-completion transcript import in progress for this meeting" -- deliberately NOT reusing
--    meetings.status, because bot.call_ended/bot.done (which reliably precede transcript.done/
--    recording.done in every real delivery) already move a meeting to status="processing" before
--    artifact-import claiming ever starts, so "processing" cannot itself distinguish "nobody is
--    importing yet" from "an import is already in flight" -- both concurrent deliveries would see
--    the same prior status and both pass a status-based guard. This column is nullable and has no
--    effect on any existing query that doesn't reference it.
--
-- 2. replace_meeting_transcript_segments(): the previous delete-then-insert for a meeting's
--    transcript was two separate, non-transactional Supabase calls -- two concurrent replacements
--    for the same meeting could each delete 0 rows (neither had inserted yet) and then both insert
--    their own full row set, doubling the transcript. This function performs both steps inside one
--    Postgres transaction, with a row lock on the meeting that serializes any concurrent
--    replacement attempt for the same meeting_id (whether or not the caller also holds the
--    application-level import claim above -- this is defense in depth, not a replacement for it).
--
-- Deliberately NOT added: any UNIQUE constraint on transcript_segments. UNIQUE(meeting_id) would be
-- invalid (one meeting legitimately has hundreds of segment rows). No stable per-segment source
-- identifier exists anywhere in this table's current schema (confirmed by the incident audit), so
-- there is no column to build a UNIQUE(meeting_id, source_segment_id)-style constraint from without
-- inventing an identifier Recall doesn't provide -- the atomic claim plus this transactional replace
-- are the complete fix for the existing schema.

alter table public.meetings
add column if not exists transcript_import_claimed_at timestamptz;

create or replace function public.replace_meeting_transcript_segments(
  p_meeting_id uuid,
  p_segments jsonb
)
returns setof public.transcript_segments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exists boolean;
begin
  -- Locks the meeting row for the remainder of this transaction, serializing any concurrent
  -- caller of this same function for the same meeting_id (both the delete and the insert below
  -- happen while this lock is held, and it's released automatically on commit/rollback).
  select true into v_exists from public.meetings where id = p_meeting_id for update;
  if v_exists is null then
    raise exception 'meeting_not_found' using errcode = 'P0002';
  end if;

  delete from public.transcript_segments where meeting_id = p_meeting_id;

  return query
  insert into public.transcript_segments (meeting_id, speaker, participant_name, text, "timestamp", raw_payload)
  select
    p_meeting_id,
    seg->>'speaker',
    seg->>'participant_name',
    seg->>'text',
    seg->>'timestamp',
    coalesce(seg->'raw_payload', '{}'::jsonb)
  from jsonb_array_elements(p_segments) as seg
  returning *;
end;
$$;

revoke all on function public.replace_meeting_transcript_segments(uuid, jsonb) from public;
revoke all on function public.replace_meeting_transcript_segments(uuid, jsonb) from anon;
revoke all on function public.replace_meeting_transcript_segments(uuid, jsonb) from authenticated;
grant execute on function public.replace_meeting_transcript_segments(uuid, jsonb) to service_role;
