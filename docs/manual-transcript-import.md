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

## Phase 2B (parser and import API)

Code: `lib/transcript-import/` (pure parser and validation, request reader, import service) and two
routes. No migration.

### Parsing (`parse.ts`, `split.ts`, `prepare.ts`)

- Formats: speaker-prefixed text (`Craig: ...`, including multi-line blocks), timestamped speaker
  blocks (`[00:02:13] Craig`, `[00:01] Craig: ...`, `Craig  0:02`), plain paragraphs, Markdown
  (headings, bold labels, bullets, front matter), WebVTT (`<v>` voice tags, NOTE/STYLE/REGION
  skipped) and SRT. A .txt file or paste that is really WebVTT/SRT is parsed as subtitles.
- Speakers are recorded only when the source names them and the document as a whole reads as
  dialogue: at least two labelled turns, covering at least 30% of paragraphs (50% if there is only
  one name). Heading words (`Action item`, `Note`, `Next steps`, ...) are never speakers. Everything
  else is `null`, which renders as "Unknown Speaker". `participant_name` is always null for imports.
- Times are offsets: `raw_payload.parfait_import.start_offset_ms` / `end_offset_ms`. `timestamp` is
  always null. No date is ever derived from an offset.
- Order: `raw_payload.parfait_import.segment_index` (0..n-1), plus `turn_index`, `fragment_index`,
  `fragment_count`, `source_line`, cue range, `content_sha256` and `parser_version` for traceability.
- Splitting: turns over 700 characters are split at sentence ends, then clauses, then spaces (a
  single longer token is cut and flagged). Analysis chunks by segment count (40-50 per chunk), so
  this bounds a chunk at about 35,000 characters. Consecutive subtitle cues from one speaker are
  re-joined up to 500 characters.
- Limits: 1 MiB of UTF-8 text (request body capped while streaming at 1 MiB + 64 KiB, under Vercel's
  4.5 MB), at most 20,000 segments (rejected, never truncated). Binary signatures, NUL, UTF-16,
  malformed UTF-8 and control-character-heavy input are rejected. The file is never stored.

### Routes

- `POST /api/meetings/import/preview`: same request reader and parser as the import; returns the
  diagnostics and sample rows. No database access, no model call.
- `POST /api/meetings/import`: multipart (`file` or `text`) or JSON (`text`), with `importId` (UUID,
  required), `title`, `meetingDate` (YYYY-MM-DD), `projectId`, and `format` for pastes.

### Import lifecycle (`service.ts`)

1. Authenticate; read, validate and parse the body (nothing touches the database before this).
2. The import id is the meeting id. If that meeting exists, resume it (step 6).
3. Check project ownership; check the per-user limits (10 per hour, 30 per day, counted from
   `meetings`).
4. INSERT the meeting: `source`, `meeting_url = null`, `recall_bot_id = null`, `platform = unknown`,
   `status = pending`, `meeting_date`, `project_id`, and `transcript_import_claimed_at = now()`, so the
   creator holds the import claim from the start. A primary-key collision means a concurrent
   duplicate: resume instead.
5. `commitTranscriptAndEnqueueAnalysis`: transactional replace, guarded `pending -> transcript_ready`,
   then the normal `enqueueMeetingAnalysis`, only for the winner.
6. Resume: another user's id, a deleted meeting or a non-manual meeting is `409 import_id_conflict`
   (identical body every time). A finished import with the same content hash is returned as
   `already_imported` and never re-queued. A pending import with the same details is re-claimed
   (free or stale claim) and finished; a live claim is `409 import_in_progress`.

Failure handling: a failed segment save releases the claim and returns `500 import_incomplete`
(`retryable: true`); the meeting stays pending with no analysis, and retrying the same request
finishes it. A crash leaves the claim held; it goes stale after 3 minutes (the route's
`maxDuration` is 60 s), after which a retry finishes the meeting. If queueing analysis fails, the
transcript is kept and the meeting is `transcript_ready`; the response says `enqueue_failed` and the
existing Analyze Meeting action retries it. Nothing is ever deleted as cleanup.

## Deployment order

1. Apply the migration to staging, then to Production.
2. Then merge the code, because merging to `main` deploys Production.

The code reads `meetings` with `select("*")` where it needs `meeting_date`, so it tolerates a database without the migration. But null timestamps and imported meetings must not be written until the migration exists everywhere the code runs.

## Known limits

- **Pipeline v2 normalization:** `persist_meeting_normalization_v2` requires a string `source_timestamp`. `lib/meeting-analysis/v2-normalization.ts` therefore refuses timestamp-less segments with an explicit error.
  - Imports use `enqueueMeetingAnalysis`, which runs v1, so this only matters if an imported meeting is allowlisted for v2.
  - The RPC must be updated before v2 analyzes imported meetings, and before v2 becomes the default.
    Imported rows are never given invented timestamps to get around this.
- **Meeting library:** newest/oldest ordering, month grouping and the "Created …" label intentionally stay on `created_at`. Whether a historical import is grouped under its meeting month is a Phase 3 product decision.

## Phase 3 (import UI and source-aware meeting page)

- **Entry:** Add Meeting has a "Send Parfait bot / Import transcript" switch; `/meetings/new?mode=import`
  opens the import form directly (the sign-in redirect keeps the query string). The bot form is unchanged.
- **Form:** `components/import-transcript-form.tsx` over `lib/transcript-import/client-session.ts`
  (a React-free state machine, so every rule is unit tested). Upload (.txt/.md/.vtt/.srt, drag and
  drop) or paste, optional title, a recommended meeting date, an optional project, then Preview,
  an explicit confirmation, and Analyze. It calls the existing preview and import routes only.
- **Retry identity:** the import UUID is created once and reused. From the moment a request that may
  have created the meeting is sent (timeout, dropped connection, a 5xx), the inputs are frozen and
  the identical request is retried; "Start new import" is the only way to a new UUID. A request the
  server refused before touching the database (bad input, unavailable project, rate limit, expired
  session) keeps the same UUID. The UUID and the non-sensitive details (mode, file name, title, date,
  project) survive a refresh in sessionStorage; the transcript never does, so the user supplies the
  same content again and the server's content hash confirms it.
- **Source-aware meeting UI** (decided by `meetings.source`, never by a missing bot id): Sync Status,
  Recall Bot ID, the meeting-link field, the bot-failure banner and live-bot polling are Recall-only;
  imports show "Imported transcript" and their meeting date (never the import date).
  `canEditMeetingUrl` and `POST /api/meetings/[id]/sync-status` refuse non-Recall meetings.
- **Known limits:** the preview shows the first six and last two segments, not the whole transcript;
  the meeting library still groups and orders imports by creation time (`created_at`), which is a
  product decision, not a bug; Pipeline v2 still cannot normalize null-timestamp rows (see above).
