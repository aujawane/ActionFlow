# CHANGELOG_AI

Meaningful product/engineering changes inferred from git history + current tree. Dates are commit dates (approx). Newest first.

## 2026-07-27

### Added

- AI project memory docs under `docs/`: `PROJECT_CONTEXT.md`, `ARCHITECTURE.md`, `FILE_INDEX.md`, `CHANGELOG_AI.md`, `DECISIONS.md`, `TODO.md`
- First-class projects with manual meeting assignment
- Project overview and milestone workspace routes
- Explicit task dependencies, ordering, merge safety, and commitment chat
- Deterministic project-aware milestone clustering and next-best-task ranking
- One global conversation-level commitment synthesis checkpoint after chunk verification
- Re-analysis-safe commitment participants and explicit lead-owner fields
- Decisions as a distinct meeting insight category

### Changed

- Primary execution navigation is Projects → Project → Milestone → Task
- Commitments now mean substantial milestones; narrower commitments convert to tasks
- Meeting and task pages link back into the project hierarchy
- Task ownership resolves from task evidence instead of inheriting the commitment lead
- Commitment workspaces group compact task tiles by owner with Unassigned last
- Meeting pages no longer repeat the complete task library across primary sections

### Reason

Make meetings evidence for durable initiatives, synthesize conversation-wide outcomes instead of chunk-level pseudo-commitments, and keep execution ownership visible without duplicated task surfaces.

### Files affected

`app/projects/`, `app/commitments/`, meeting/commitment/task APIs, `components/commitment-workspace.tsx`, `lib/project-execution.ts`, execution-intelligence stages/consolidation/prompts, `20260727110000_add_project_execution_hierarchy.sql`, `20260727120000_add_commitment_people.sql`, tests, and AI memory docs

---

## 2026-07-24

### Added

- Commitment-first UI hierarchy (commitments → standalone → ideas → work-by-owner)
- Deterministic consolidation stage + `execution_classification`
- Background analysis jobs + internal chained worker (`transcript_ready` → 202 analyze)
- Analysis status UI; commitment progress from child tasks

### Changed

- Analyze no longer runs full pipeline inline; worker stages + checkpoint
- Follow-up emails / owner workload filtered to `committed` only
- Extraction prompts: outcomes vs steps; zero-task commitments allowed

### Fixed

- Over-fragmentation mitigated via merge + restatement rejection (quality signal, not hard cap)

### Files affected

`lib/execution-intelligence/*`, `lib/meeting-analysis/*`, `lib/execution-display.ts`, `app/api/meetings/[id]/analyze`, `app/api/internal/meeting-analysis/worker`, `components/commitments-panel.tsx`, related migrations `2026072414*`, `2026072415*`

### Reason

Meetings produced duplicate/restatement-heavy graphs; Vercel timeouts on inline analysis.

---

## 2026-07-22 / 2026-07-23

### Added

- Commitment-centered execution intelligence (commitments parent tasks)
- Atomic `replace_meeting_execution_graph` with UUID matching
- Generation/stale-run protection; manual override preservation
- Salvage for malformed model items; bounded OpenAI timeouts
- Production/staging safety migrations + readiness reports

### Changed

- Persistence from destructive replace toward merge/retain user work

### Files affected

`lib/execution-intelligence/`, `supabase/migrations/202607230*`, `2026072313*`, UI commitments section

### Reason

Make Commitments → Tasks first-class and safe for re-analysis.

---

## 2026-07-14

### Added

- Follow-up email drafts (assignee + team summary)
- Task categorization + category-aware deliverables
- Ask Parfait task chat / clarification patches
- Manual speaker resolution aliases for same-device speakers

### Files affected

follow-up email service/routes, task categorize/deliverable/comments, speaker alias APIs/UI

### Reason

Close loop from extracted tasks to owner communication and editable workspace.

---

## 2026-07-07 – 2026-07-13

### Added

- Zoom + Google Meet start-meeting integrations
- Execution dashboard (work by owner)
- Meeting library sorting/pinning
- Hybrid speaker diarization fields + unknown-speaker fixes
- Auto sync for transcript readiness

### Fixed

- Sync button / automatic syncing
- Unknown speaker bugs

### Files affected

`lib/meeting-providers.ts`, Google/Zoom routes, dashboard components, Recall processing

### Reason

Users need to start meetings in-product and see execution load by owner.

---

## 2026-06-29 – 2026-06-30

### Added

- Intelligent task workspace fields/artifacts
- Commitment detection (early)
- Owner detection

### Files affected

task workspace migrations/APIs, early analysis paths

### Reason

Move from transcript dump to actionable owned work.

---

## 2026-06-17 – 2026-06-22

### Added

- Topic segmentation + topic-based analysis
- Improved login/signup UI

### Files affected

`meeting_topics`, analysis helpers, auth UI

---

## 2026-06-10 (foundation)

### Added

- Next.js + Supabase wiring
- Recall bot creation + webhook transcript ingest
- Transcript analysis + prompt generation
- Initial frontend polish

### Files affected

`app/`, `lib/recall/`, `lib/analysis.ts`, early `supabase/schema.sql`

### Reason

MVP: join meeting, capture transcript, analyze.

---

# Current State

Parfait implements end-to-end: auth → meeting bot → transcript → background extraction → project-aware milestone consolidation → Projects → Milestones → dependency-aware Tasks → Deliverables. Meeting pages remain evidence/history; project and milestone pages are the primary execution surfaces.

Ops: migrations through the project hierarchy are in-repo but not applied to production. Staging quality and SQL execution remain the rollout gate. Prefer `docs/execution-intelligence.md` for pipeline detail.
