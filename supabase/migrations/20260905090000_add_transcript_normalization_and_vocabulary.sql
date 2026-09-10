-- Project-aware transcript normalization + vocabulary.
--
-- transcript_segments.text remains the immutable raw Recall transcript -- it is never overwritten
-- by normalization. Four new nullable columns hold the derived, normalized representation and
-- its audit trail; they stay null until a normalization run actually processes that segment, so
-- historical meetings are never implicitly rewritten by this migration.
alter table public.transcript_segments
  add column if not exists normalized_text text,
  add column if not exists normalization_corrections jsonb,
  add column if not exists normalized_at timestamptz,
  add column if not exists normalization_failed_at timestamptz;

comment on column public.transcript_segments.text is
  'Immutable raw transcript text exactly as Recall returned it. Never overwritten by normalization.';
comment on column public.transcript_segments.normalized_text is
  'Corrected text for this segment, only set when a normalization run actually changed it. Null means "same as text" -- downstream readers should use coalesce(normalized_text, text).';
comment on column public.transcript_segments.normalization_corrections is
  'Full list of corrections proposed for this segment (including any below the auto-apply confidence threshold), each carrying original/replacement/confidence/reason/source. Null means normalization has not proposed anything for this segment.';
comment on column public.transcript_segments.normalized_at is
  'When a normalization run last SUCCEEDED for this segment. Null means either never attempted, or the most recent attempt failed (see normalization_failed_at) -- downstream readers fall back to the raw text either way, and a null value here means this segment is eligible to be retried by the next normalization run.';
comment on column public.transcript_segments.normalization_failed_at is
  'When a normalization attempt for this segment most recently failed (transient model/API error), distinct from "never attempted". Cleared back to null the next time normalization succeeds for this segment. Never set at the same time as normalized_at.';

-- Project-scoped vocabulary: canonical terms/aliases used to ground transcript normalization.
-- Mirrors the existing project_requirements/project_decisions/project_constraints shape and RLS
-- pattern (see can_access_project below) rather than inventing a new access-control scheme.
create table public.project_vocabulary (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  canonical_term text not null
    check (length(trim(canonical_term)) > 0 and canonical_term = trim(canonical_term)),
  aliases text[] not null default '{}'::text[],
  term_type text not null default 'other'
    check (term_type in ('tool', 'person', 'acronym', 'term', 'other')),
  -- Provenance only -- where this term originally came from. Does NOT determine trust; see
  -- `status` below. 'user_added': originally entered by a human. 'ai_suggested': originally
  -- discovered by AI during normalization. An AI-suggested term a human later approves keeps
  -- source='ai_suggested' forever (that history is worth preserving) even though it becomes
  -- fully trusted once status='approved'.
  source text not null default 'user_added'
    check (source in ('user_added', 'ai_suggested')),
  -- The trust boundary -- independent of `source` above. 'approved': trusted; may ground
  -- normalization and participate in deterministic alias correction, regardless of whether it
  -- was originally user_added or ai_suggested. 'suggested': AI-discovered candidate awaiting
  -- review; not trusted, must never ground normalization or drive a correction (deterministic or
  -- otherwise). 'rejected': explicitly declined; not trusted, kept for history so the same
  -- suggestion isn't re-proposed indefinitely.
  status text not null default 'approved'
    check (status in ('approved', 'suggested', 'rejected')),
  confidence numeric not null default 1.0 check (confidence >= 0 and confidence <= 1),
  evidence_meeting_id uuid references public.meetings (id) on delete set null,
  evidence_segment_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

comment on table public.project_vocabulary is
  'Project-scoped canonical terms/aliases (tools, people, acronyms, terminology) used to ground transcript normalization. Never shared across projects.';

-- Case-insensitive uniqueness per project so "Vercel" and "vercel" can't both be suggested/added,
-- and doubles as the ON CONFLICT target for idempotent AI-suggestion upserts.
create unique index project_vocabulary_term_idx
on public.project_vocabulary (project_id, lower(canonical_term));

create index project_vocabulary_project_status_idx
on public.project_vocabulary (project_id, status);

create trigger project_vocabulary_set_updated_at before update on public.project_vocabulary
for each row execute procedure public.set_updated_at();

alter table public.project_vocabulary enable row level security;

create policy "project_vocabulary_owner_all" on public.project_vocabulary for all
using (public.can_access_project(project_id))
with check (public.can_access_project(project_id));

revoke all on table public.project_vocabulary from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.project_vocabulary
to anon, authenticated, service_role;
