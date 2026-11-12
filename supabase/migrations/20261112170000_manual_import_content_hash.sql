-- Manual transcript import hardening, applied AFTER 20261111090000.
-- Preserve the initial transcript identity across failed saves and retries.
-- Nullable for historical/staging manual rows created before this migration.
-- New imports always populate the hash in the same INSERT as the meeting.
alter table public.meetings
  add column transcript_import_content_sha256 text;

alter table public.meetings
  add constraint meetings_import_content_sha256_format_check
  check (
    transcript_import_content_sha256 is null
    or transcript_import_content_sha256 ~ '^[0-9a-f]{64}$'
  );

comment on column public.meetings.transcript_import_content_sha256 is
  'Immutable SHA-256 of the original parsed transcript import; persists before segments are saved.';
