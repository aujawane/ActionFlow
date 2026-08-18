# FILE_INDEX

Important paths only. Skip `node_modules/`, `.next/`, `.vercel/`, generated types, lockfile noise.

## Root

- `middleware.ts` — Supabase session refresh
- `package.json` — scripts + deps
- `.env.example` — documented env vars
- `next.config.ts` — Next config
- `README.md` — human setup (agents: prefer PROJECT_CONTEXT)

## app/

App Router pages and API.

- `app/page.tsx` — marketing/landing entry
- `app/layout.tsx` — root layout
- `app/globals.css` — global styles
- `app/dashboard/page.tsx` — meeting library
- `app/meetings/new/page.tsx` — create meeting
- `app/meetings/[id]/page.tsx` — meeting detail + execution UI
- `app/projects/page.tsx` — project library/create
- `app/projects/[id]/page.tsx` — project execution overview
- `app/commitments/[id]/page.tsx` — milestone workspace
- `app/tasks/[id]/page.tsx` — task workspace
- `app/account/*` — account / password reset pages
- `app/(auth)/*` — login/signup/forgot-password routes

### app/api/

- `meetings/route.ts` — list/create meetings
- `meetings/start/route.ts` — start Zoom/Meet + bot
- `meetings/[id]/route.ts` — meeting CRUD-ish
- `meetings/[id]/analyze/route.ts` — enqueue analysis (202)
- `meetings/[id]/analysis-status/route.ts` — job status
- `meetings/[id]/sync-status/route.ts` — transcript sync
- `meetings/[id]/transcript/route.ts` — transcript API
- `meetings/[id]/generate-prompts/route.ts` — prompt gen
- `meetings/[id]/follow-up-emails/*` — follow-up drafts
- `meetings/[id]/pin/route.ts` — pin meeting
- `meetings/[id]/project/route.ts` — manual project assignment/create
- `projects/*` — project CRUD
- `projects/[id]/brain/route.ts` — bounded project-aware chat + persistence
- `projects/[id]/brain/proposals/*` — proposal review, rejection, and atomic apply
- `commitments/[id]/tasks/*` — task create/reorder/merge
- `commitments/[id]/comments/route.ts` — milestone chat
- `tasks/[id]/route.ts` / `dependencies/route.ts` — general task edits + blockers
- `recall/webhook/route.ts` — Recall HMAC webhook
- `internal/meeting-analysis/worker/route.ts` — durable stage worker
- `commitments/[id]/route.ts` — commitment updates
- `tasks/[id]/owner|comments|artifacts|categorize|prompt|guide|deliverable|generate*/route.ts` — task workspace APIs
- `integrations/google/*` — Google OAuth connect
- `integrations/route.ts` — integration status
- `auth/*` — auth callback / password reset
- `account/*` — password code / security events
- `health/route.ts` — health check
- `dev/*` — debug/reimport (dev)

## components/

Shared UI (client/server mix).

- `commitments-panel.tsx` — commitment cards + nested tasks
- `project-library.tsx` — project create/list cards
- `meeting-project-assignment.tsx` — meeting project picker
- `commitment-workspace.tsx` — milestone editing/task sequencing/chat
- `project-brain-panel.tsx` — responsive chat, memory, proposal diff/review
- `project-brain-operation-review.tsx` — grouped human-readable operation diffs + advanced validation
- `standalone-tasks-panel.tsx` — committed tasks without commitment
- `ideas-requirements-panel.tsx` — non-committed items
- `execution-dashboard.tsx` — work-by-owner metrics/view
- `meeting-analysis-status.tsx` — analysis job progress
- `meeting-actions.tsx` — analyze/sync/actions
- `meeting-library.tsx` / `meeting-card.tsx` — dashboard list
- `live-transcript.tsx` / `live-meeting-status-badge.tsx` — live status
- `speaker-mapping-panel.tsx` — alias mapping
- `topic-results.tsx` / `insights-panel.tsx` / `prompts-panel.tsx`
- `task-clarifications.tsx` — Ask Parfait chat
- `task-workspace-task-state.tsx` / `task-execution-panel.tsx` / badges
- `meeting-follow-up-emails.tsx` — email drafts UI
- `start-meeting-panel.tsx` / `new-meeting-form.tsx`
- `auth-form.tsx` / password forms / `sidebar-nav.tsx` / account menus
- `integrations-settings-client.tsx` — Google connect UI

## lib/

Domain logic.

### lib/execution-intelligence/

- `schemas.ts` — Zod/JSON graph contracts
- `execution-v2.ts` — responsibility adapter, promotion guard, and reasoning trace
- `prompts.ts` — model instructions
- `model.ts` — OpenAI structured calls + timeouts
- `stages.ts` — candidate/verify/completeness stages
- `chunking.ts` / `graph-batching.ts` — scale for long transcripts
- `graph.ts` — grounding, link repair, semantic dedupe
- `consolidation.ts` — commitment-first merge/restatement reject
- `normalization.ts` / `salvage.ts` / `matching.ts` / `linking.ts` / `resolution.ts`
- `pipeline.ts` — sync end-to-end orchestration
- `durable-pipeline.ts` — stage fns for worker
- `persistence.ts` — RPC persistence wrapper
- `observability.ts` / `evaluation.ts` / `fixture-harness.ts`

### lib/meeting-analysis/

- `jobs.ts` — claim/update job + stages metadata
- `enqueue.ts` — claim + dispatch worker
- `topics.ts` — topic prep for pipeline
- `worker.ts` — one-stage execution + chain

### lib/project-brain/

- `schemas.ts` — typed proposal operations and response validation
- `context.ts` — bounded project graph/memory context + meeting-analysis memory projection
- `agent.ts` — Project Brain prompt, structured OpenAI response, deterministic high-confidence interpretations
- `operations.ts` — operation grouping, aliases, individual validation, and milestone completeness rules

### lib/recall/

- `client.ts` — Recall HTTP client
- `processing.ts` — completed meeting import → transcript_ready + enqueue
- `transcript.ts` — transcript parse/normalize

### other lib/

- `env.ts` — lazy Zod env validation
- `types.ts` — shared TS types
- `auth.ts` / `api-auth.ts` — page/API auth helpers
- `analysis.ts` — transcript insights/topics helpers
- `openai.ts` — OpenAI client wrapper
- `execution-display.ts` — classify/partition/progress for UI+emails
- `project-access.ts` — ownership-scoped project entity lookup
- `project-execution.ts` — project progress, view models, next-best ranking
- `meeting-follow-up-email-service.ts` / `meeting-follow-up-emails.ts`
- `meeting-providers.ts` / `meeting-platform.ts` / `google-integration.ts`
- `transcript-speaker.ts` / `meeting-participants.ts` — Recall attribution and participant choices
- `manual-overrides.ts` — re-analysis override tracking
- `meeting-task-query.ts` — legacy column fallback
- `task-*` — categorization, deliverables, comments, workspace, display
- `ai/task-chat-patch.ts` — structured task chat mutations
- `prompt-generation.ts` — meeting prompt generation
- `transcript-segments.ts` — segment utilities
- `user-profile.ts`
- `supabase/{admin,client,server,middleware}.ts` — Supabase clients

## supabase/

- `schema.sql` — early baseline (incomplete)
- `migrations/*.sql` — real schema evolution (source of truth)
- Key late migrations: execution commitments, graph safety, analysis jobs, checkpoint, classification
- `20260727110000_add_project_execution_hierarchy.sql` — projects, links, dependencies, chat, safety RPCs
- `20260727120000_add_commitment_people.sql` — explicit milestone leads and participants
- `20260727130000_project_brain_phase1.sql` — memory/chat/proposals/audit/RLS/versioned atomic apply

## scripts/

- `evaluate-execution-intelligence.ts` — offline metrics
- `run-execution-intelligence-live-eval.ts` — live OpenAI fixtures
- `diagnose-execution-candidates.ts` — candidate debugging
- `copy-meeting-to-staging.ts` — prod→staging copy
- `sql/install-copy-meeting-to-staging-rpc.sql` — staging RPC helper

## tests/

- `execution-*.test.ts` — graph, consolidation, chunking, normalization
- `project-first-execution.test.ts` — milestone clustering, progress, blockers, evidence, migration safety
- `project-brain.test.ts` — memory, proposals, Jamileh flow, schema/RLS/RPC/UI contracts
- `background-analysis-jobs.test.ts` — enqueue/job semantics
- `production-execution-safety.test.ts` / `staging-readiness.test.ts`
- `task-*.test.ts` — comments/patches/deliverables
- `recall-transcript.test.ts` / `transcript-speaker.test.ts` / `env-app-url.test.ts`
- `fixtures/` — eval fixtures + live predictions JSON

## docs/

### AI memory (maintain)

- `PROJECT_CONTEXT.md` — agent entry
- `ARCHITECTURE.md` — how systems connect
- `FILE_INDEX.md` — this file
- `CHANGELOG_AI.md` — AI changelog
- `DECISIONS.md` — ADRs-lite
- `TODO.md` — prioritized work

### Feature docs

- `execution-intelligence.md` — pipeline deep dive
- `execution-intelligence-v2.md` — responsibility-first V2 architecture and debugging
- `deployment-vercel.md` — Vercel deploy + timeouts
- `copy-meeting.md` — staging copy runbook

## Root reports (reference, not runtime)

- `PRODUCTION_READINESS_REPORT.md`, `STAGING_READINESS_REPORT.md`
- `EXECUTION_INTELLIGENCE_*`, `TASK_EXTRACTION_AUDIT.md`
