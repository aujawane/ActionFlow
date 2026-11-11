# Manual transcript import

Lets a user analyze a historical meeting by uploading (`.txt`, `.md`, `.vtt`, `.srt`) or pasting a
transcript. An imported transcript becomes an ordinary Parfait meeting and goes through the same
analysis path as a Recall meeting. There is no separate analyzer.

```
Recall bot ──── claim → fetch → parse ──┐
Upload / paste ──── parse (Phase 2) ────┤
                                        ▼
       commitTranscriptAndEnqueueAnalysis   (lib/transcript-commit.ts)
         replace_meeting_transcript_segments RPC  (transactional, meeting row locked)
         guarded status → transcript_ready        (only the winner continues)
         enqueueMeetingAnalysis                   (the normal entry point; never /analyze-v2)
                                        ▼
               existing pipeline, persistence and meeting page
```

## Phase 1 (schema and shared foundations)

- Migration `20261111090000_add_manual_transcript_import_foundation.sql`:
  - `meetings.meeting_url` and `transcript_segments."timestamp"` become nullable.
  - Adds `meetings.source` (text, NOT NULL, default `recall`, CHECK `recall | manual_upload | manual_paste`).
  - Adds `meetings.meeting_date` (date, nullable).
  - Existing rows are not rewritten.
- `lib/transcript-commit.ts` is the source-independent tail. Recall uses it after its own claim, fetch and parse.
- Imported source order is stored as `raw_payload.parfait_import.segment_index`. It is the top ordering signal in `lib/transcript-order.ts`, and only a non-negative safe integer is accepted.
- A null `timestamp` is never rendered as a time. Model lines omit the `[time]` token, and the UI shows the speaker only.
- `getEffectiveMeetingDate(meeting)` (`lib/meeting-date.ts`) returns `meeting_date ?? created_at`. Use it for "when the meeting happened"; keep `created_at` for "when the record was created".
- `getMeetingSource(meeting)` (`lib/meeting-source.ts`) treats a missing source as `recall`. Never infer the source from `recall_bot_id`, because a Recall meeting whose bot creation failed also has none.

## Deployment order

1. Apply the migration to staging, then to Production.
2. Then merge the code, because merging to `main` deploys Production.

The code reads `meetings` with `select("*")` where it needs `meeting_date`, so it tolerates a database without the migration. But null timestamps and imported meetings must not be written until the migration exists everywhere the code runs.

## Known limits

- **Pipeline v2 normalization:** `persist_meeting_normalization_v2` requires a string `source_timestamp`. `lib/meeting-analysis/v2-normalization.ts` therefore refuses timestamp-less segments with an explicit error.
  - Imports use `enqueueMeetingAnalysis`, which runs v1, so this only matters if an imported meeting is allowlisted for v2.
  - The RPC must be updated before v2 analyzes imported meetings.
- **Meeting library:** newest/oldest ordering, month grouping and the "Created …" label intentionally stay on `created_at`. Whether a historical import is grouped under its meeting month is a Phase 3 product decision.

## Phase 3: Recall-only UI to gate on `!isRecallMeeting(meeting)`

| Where | What changes for imported meetings |
| --- | --- |
| `components/meeting-actions.tsx` (`isSyncStatusRecoverable(meetingStatus)`) | Hide **Sync Status**. |
| `app/api/meetings/[id]/sync-status/route.ts` | Reject non-Recall meetings explicitly. Today the only guard is the 400 "no Recall bot id". |
| `components/meeting-details-editor.tsx`: the `meetingPlatformLabel` badge, the "Recall Bot ID" rows, and the Meeting Link field | Hide the bot and link details. Show an "Imported transcript" source label instead of the platform. |
| `lib/meeting-details.ts` `canEditMeetingUrl` (used by the editor and by `PATCH /api/meetings/[id]`) | Add `isRecallMeeting(meeting)` to the rule. As written, an imported meeting that is still `pending` with no bot ID would allow link editing. |
| `app/meetings/[id]/page.tsx` (the "Bot creation failed" banner when status is `failed`) | Use import-specific wording; no bot was involved. |
| `components/live-transcript.tsx` (`ACTIVE_STATUSES` polling) and `components/live-meeting-status-badge.tsx` | Imported meetings should never sit in `joining`/`recording`/`processing`. Don't start live-status polling for them. |
| `components/meeting-library.tsx` (`meetingPlatformLabel`, `failed` state) | Show the source instead of the platform. |
