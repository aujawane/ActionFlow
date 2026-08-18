# PROJECT_CONTEXT

AI agent entrypoint. Read this, then `CHANGELOG_AI.md` and `TODO.md`, before coding.

## Purpose

**Parfait** turns meetings into project execution:

```text
Project / Initiative → Commitments / Milestones → Tasks → Deliverables
                       ↑ meeting evidence/history
```

Captures transcripts via Recall.ai bots, extracts commitments/tasks with OpenAI, and helps owners execute via workspace, prompts, deliverables, and follow-up emails.

## Tech stack

- Next.js 15 App Router + React 19 + TypeScript (strict)
- Tailwind CSS
- Supabase (Auth, Postgres, RLS); server uses service role
- OpenAI (`responses.create`, structured JSON)
- Recall.ai (bots + webhooks)
- Zoom S2S OAuth + Google OAuth (Meet)
- Zod validation; deploy target Vercel Pro (Node runtime)

## Status

**Implemented:** auth, meeting create/start, Recall transcript attribution, topic segmentation, background analysis, first-class projects with manual meeting assignment, global conversation-level commitment synthesis, Project Brain chat/memory/reviewable atomic proposals, dependency-aware next task ranking, owner-grouped commitment workspaces, deliverables, follow-up emails, Google/Zoom integrations.

**Ops gap:** additive migrations through `20260727130000_*` exist in repo; **do not apply to production** until gated. Staging must apply the project hierarchy, commitment people, and Project Brain migrations before the new workspaces use real data.

## Main features

1. Auth (email) + profiles
2. Create meeting from URL or start Zoom/Meet via integrations
3. Recall bot join + webhook transcript import → `transcript_ready`
4. Background analysis worker (202 analyze → chained internal stages)
5. Manual projects + meeting assignment
6. Projects → Project → Milestone → Task primary navigation
7. Commitment workspace: owner-grouped compact task tiles, people, CRUD/merge/reorder/dependencies, evidence, chat
8. Dependency-aware next best task + computed project progress
9. Task workspace, category-aware deliverables, committed-only follow-ups
10. Speaker roster + manual aliases
11. Project Brain: structured project memory, persistent contextual chat, outcome-level milestone planning, human-readable diff review, explicit approval, version-checked atomic apply, and audit history

## WIP / recent focus

- Global conversation-level synthesis quality vs over-extraction
- Project Brain proposal quality and staging SQL/RLS verification
- Project Brain milestone-plan quality across real scope changes
- Staging verify of classification, background jobs, and project hierarchy migrations
- Live-model quality gate (hallucination threshold historically exceeded)

## Commands

```bash
npm install
npm run dev
npm test
npm run lint
npm run typecheck
npm run build
npm run eval:execution
npm run eval:execution:live
npm run diagnose:execution-candidates
npm run copy-meeting -- <meeting_id> <staging_user_id>
```

## Important dependencies

`next`, `react`, `@supabase/ssr`, `@supabase/supabase-js`, `openai`, `zod`, `tsx` (tests/scripts), `tailwindcss`.

## Environment

See `.env.example`. Core: `NEXT_PUBLIC_APP_URL`, `INTERNAL_APP_URL`, Supabase trio, `OPENAI_*`, `RECALL_*`. Optional: Zoom, Google, `RECALL_WEBHOOK_URL`, `EXECUTION_INTELLIGENCE_TIMEOUT_MS`. Staging copy script uses `PRODUCTION_*` / `STAGING_*` (not in example; see `docs/copy-meeting.md`).

## Repo structure

```text
app/           App Router pages + API routes
components/    UI
lib/           Domain logic (execution-intelligence, meeting-analysis, recall, tasks)
supabase/      schema.sql baseline + migrations/
scripts/       eval, diagnose, copy-meeting
tests/         node:test via tsx
docs/          AI memory + feature docs
```

Path alias: `@/*` → repo root.

## Coding conventions

- Prefer additive migrations; never weaken re-analysis preservation or stale-generation checks
- Service-role-only for graph RPCs; verify HMAC/internal secret on webhooks/workers
- Server components for data load; client components for interactive panels
- Match existing patterns; no drive-by refactors
- Keep AI memory docs (`docs/PROJECT_CONTEXT.md`, `CHANGELOG_AI.md`, `TODO.md`, `DECISIONS.md`) updated after tasks
- Deep feature detail: `docs/execution-intelligence.md`, `docs/deployment-vercel.md`

## Known issues / risks

- Model over-extraction / hallucination quality gate not fully green (see `PRODUCTION_READINESS_REPORT.md`)
- `supabase/schema.sql` is incomplete vs migrations — prefer migrations as source of truth
- Vercel Hobby timeouts break analysis; Pro + chained worker required
- Project/classification columns absent until migrations are applied
- Global synthesis may require up to 90 seconds and can still vary by model run
- Consolidation may rare-false-merge similar phrasings
- Project Brain creation of milestones still requires at least one meeting because execution rows remain meeting-backed in Phase 1

## Roadmap (high level)

1. Staging migrate + re-analyze quality meetings; tune consolidation/prompts
2. Clear live hallucination gate before production migration
3. Harden background worker observability/retries in production
4. Tune outcome synthesis/task recall and add automatic meeting-to-project linking later
