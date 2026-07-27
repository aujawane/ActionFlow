# ARCHITECTURE

How Parfait fits together. Prefer this over scanning the whole tree.

## High level

```text
Browser (App Router)
  → Supabase Auth session (middleware)
  → RSC pages load via supabaseAdmin (service role, scoped by user_id)
  → Client panels call /api/*

External:
  Recall.ai ← bots / webhooks
  OpenAI ← analysis, prompts, deliverables, chat patches
  Zoom / Google ← meeting creation + OAuth tokens in user_integrations
  Supabase Postgres ← source of truth
```

Deploy: Next.js on **Vercel Pro**. Long analysis does **not** run inline in analyze; it uses DB-checkpointed worker hops.

Primary execution hierarchy:

```text
Projects → Project → Commitment/Milestone → Task → Deliverable
Meetings remain source evidence and analysis history.
```

## Data flow (meeting lifecycle)

1. User creates/starts meeting → `meetings` row + Recall bot (`lib/recall/client.ts`)
2. Recall webhook `/api/recall/webhook` → status updates + transcript segments
3. Import completes → `meetings.status = transcript_ready` (`lib/recall/processing.ts`)
4. Analysis enqueued (`lib/meeting-analysis/enqueue.ts`) — sync path does not await full pipeline
5. `POST /api/meetings/[id]/analyze` → claim generation + enqueue → **202**
6. `POST /api/internal/meeting-analysis/worker` runs **one stage**, persists checkpoint, chains next via `after()`
7. Stages: topics → candidates → verification → completeness → final verify → duplicate consolidation → milestone parent/child clustering → `replace_meeting_execution_graph` → categorization
8. UI polls `GET .../analysis-status`; meeting → `completed` on success

## Execution intelligence pipeline

```text
Transcript + speaker aliases
  → topic segmentation
  → high-recall candidates (chunked)
  → verification / linking / owner-date resolution
  → deterministic grounding + dedupe
  → completeness
  → final verification + grounding
  → consolidateExecutionGraph (deterministic)
  → atomic persistence (generation-locked)
```

Only `execution_classification = committed` drives main queue, owner workload, follow-ups. `proposed` / `requirement` / `future_consideration` → Ideas panel.

Modules: `lib/execution-intelligence/*`. Worker orchestration: `lib/meeting-analysis/*`. Display partition: `lib/execution-display.ts`.

## API flow (key)

| Route | Role |
|-------|------|
| `POST /api/meetings`, `POST /api/meetings/start` | Create / start meeting + bot |
| `POST /api/recall/webhook` | HMAC Recall events |
| `POST /api/meetings/[id]/sync-status` | Poll/import transcript; may enqueue analysis |
| `POST /api/meetings/[id]/analyze` | Claim + enqueue analysis (202) |
| `GET/POST /api/projects`, `GET/PATCH /api/projects/[id]` | Manual project management |
| `PATCH /api/meetings/[id]/project` | Assign/create project for a meeting |
| `/api/commitments/[id]/tasks/*` | Create/reorder/merge milestone tasks |
| `PUT /api/tasks/[id]/dependencies` | Replace explicit blockers |
| `/api/commitments/[id]/comments` | Milestone Ask Parfait |
| `GET /api/meetings/[id]/analysis-status` | Job progress |
| `POST /api/internal/meeting-analysis/worker` | Internal secret; one stage |
| `PATCH` commitments/tasks owner/status routes | Manual overrides + preserve flags |
| `POST /api/tasks/[id]/comments` | Clarifications / chat patches |
| `POST /api/tasks/[id]/generate*` / deliverable / prompt | AI workspace |
| `POST /api/meetings/[id]/follow-up-emails/*` | Email drafts from committed work |
| `GET/POST /api/integrations/google/*` | Google OAuth |

Auth for user APIs: `lib/api-auth.ts` / `requireUser`. Internal worker: `RECALL_WEBHOOK_SECRET` header.

## Database (summary)

**Baseline:** `supabase/schema.sql` (profiles, meetings, transcript_segments, insights, prompts) — incomplete vs prod.

**Truth:** `supabase/migrations/*`

Core tables:

- `profiles`, `meetings` (+ `execution_graph_generation`, statuses including `transcript_ready`)
- `projects`; nullable `project_id` on meetings/commitments/tasks
- `transcript_segments` (speaker / diarized / resolved)
- `meeting_speaker_aliases`, `meeting_topics`
- `meeting_commitments`, `meeting_tasks` (+ `commitment_id`, overrides, evidence, `execution_classification`)
- `task_comments`, `task_artifacts`, `meeting_artifacts`
- `extracted_insights`, `generated_prompts`
- `user_integrations`, `account_verification_events`
- `meeting_analysis_jobs` (+ `checkpoint` jsonb)
- `task_dependencies`, `commitment_comments`

Critical RPCs: `replace_meeting_execution_graph` (generation-safe merge), `assign_meeting_project` (atomic propagation), and `merge_commitment_tasks` (moves artifacts/comments/dependencies). All are service-role only.

## Auth flow

1. Supabase email auth UI (`components/auth-form.tsx`)
2. `middleware.ts` → `lib/supabase/middleware.ts` refreshes session cookies
3. Pages: `requireUser()` (`lib/auth.ts`)
4. API: session or trusted internal secret
5. Data mutations often via `supabaseAdmin` with explicit `user_id` checks (RLS exists; admin bypasses — app must enforce ownership)

## Folder responsibilities

| Path | Responsibility |
|------|----------------|
| `app/` | Routes, layouts, API handlers only |
| `components/` | Presentational + client interaction |
| `lib/` | Business logic, clients, pipelines |
| `lib/execution-intelligence/` | Extract/verify/consolidate/persist graph |
| `lib/meeting-analysis/` | Job state + durable worker stages |
| `lib/recall/` | Recall API + transcript processing |
| `supabase/` | SQL schema evolution |
| `scripts/` | Offline/live eval, staging copy |
| `tests/` | Unit/integration via `tsx --test` |

## State management

- Server: Postgres is source of truth; RSC refetch on navigation
- Client: local React state in panels (expand/collapse, forms); no global Redux
- Analysis progress: polled from `meeting_analysis_jobs`
- Manual edits: columns + override metadata so re-analysis merge preserves them

## Major UI components

- Meeting page: analysis status → commitments → standalone tasks → ideas → work-by-owner → topics → transcript
- Projects page: project library/create; project page: progress, next task, milestones, people, meetings, deliverables
- Milestone page: editable commitment, ordered/dependent tasks, evidence, deliverables, chat
- `CommitmentsPanel`, `StandaloneTasksPanel`, `IdeasRequirementsPanel`, `ExecutionDashboard`
- Task page: workspace state, clarifications chat, artifacts, badges
- Dashboard: meeting library / cards / start panel

## Important services

- `lib/meeting-analysis/worker.ts` — stage runner
- `lib/execution-intelligence/pipeline.ts` + `durable-pipeline.ts`
- `lib/execution-intelligence/persistence.ts`
- `lib/meeting-follow-up-email-service.ts`
- `lib/task-deliverable-service.ts`, `lib/task-categorization.ts`
- `lib/ai/task-chat-patch.ts`
- `lib/speaker-resolution.ts`, `lib/speaker-aliases.ts`

## External integrations

- **Recall:** create bot, webhook HMAC, fetch completed transcript
- **OpenAI:** structured extraction, prompts, deliverables, chat patches
- **Zoom:** account-level S2S meeting create (no browser OAuth callback)
- **Google:** user OAuth tokens in `user_integrations` for Meet
- **Supabase:** auth + DB
- **Vercel:** hosting; `after()` for worker chaining; `maxDuration` 300 on worker
