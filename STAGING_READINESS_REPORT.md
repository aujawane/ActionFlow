# Staging Readiness Report

**Date:** 2026-07-22

## Changes made

1. **Server-only execution graph RPC**
   - Preserved `SET search_path = public`.
   - Added meeting existence/deleted-state validation before any graph deletion.
   - Revoked function execution from `PUBLIC`, `anon`, and `authenticated`.
   - Granted execution only to `service_role`.
   - Documented the RPC as server-only with SQL comments.

2. **Bounded execution-intelligence model calls**
   - Added a 25-second timeout to every candidate, verification, and completeness request. Both verification invocations use the same bounded adapter.
   - Disabled OpenAI SDK retries for these calls and retained exactly two application-level attempts.
   - Abort signals and an explicit timeout race prevent requests from hanging until the Vercel route is killed.

3. **Structured observability**
   - Added structured timeout, retry, and validation-failure events.
   - Added explicit initial and final verified graph counts.
   - Existing candidate-count, persistence-failure, and pipeline-summary/final-count logs remain in place.

4. **Speaker alias propagation**
   - Alias changes now update both `owner` and `owners` for commitments and tasks.
   - Previous display names are also replaced when an alias is renamed.

5. **Legacy task query fallback**
   - Meeting pages first query current task columns.
   - Missing optional execution-intelligence columns trigger a legacy-column query.
   - Genuine query failures are still surfaced; legacy tasks are not hidden.

6. **User-work protection during re-analysis**
   - Analyze checks all existing meeting tasks for artifacts and comments before extraction.
   - If either exists, analysis returns HTTP 409 with code `REANALYSIS_PROTECTED` and counts.
   - The meeting page disables manual Analyze and displays an actionable warning.
   - Atomic graph replacement is unchanged.

7. **Focused regression tests**
   - RPC permissions/search path/server-only validation.
   - Timeout and bounded retry behavior.
   - Task owner-array alias propagation.
   - Legacy task-query fallback.
   - Re-analysis blocking for artifacts/comments.

## Files changed

- `supabase/migrations/20260723010000_add_execution_commitments.sql`
- `lib/execution-intelligence/model.ts`
- `lib/execution-intelligence/observability.ts`
- `lib/execution-intelligence/pipeline.ts`
- `lib/speaker-resolution.ts`
- `lib/meeting-task-query.ts` (new)
- `lib/reanalysis-protection.ts` (new)
- `app/api/meetings/[id]/analyze/route.ts`
- `app/meetings/[id]/page.tsx`
- `components/meeting-actions.tsx`
- `tests/staging-readiness.test.ts` (new)
- `STAGING_READINESS_REPORT.md` (new)

## Validation results

| Command | Result |
|---|---|
| `npm test` | **Pass** — 48/48 |
| `npm run lint` | **Pass** — no warnings or errors |
| `npm run typecheck` | **Pass** |
| `npm run build` | **Pass** — production build completed |

## Deployment actions still required

1. Apply `20260723010000_add_execution_commitments.sql` to the staging Supabase project.
2. Confirm the deployed function privileges show execute only for `service_role`.
3. Confirm the target Vercel plan honors `maxDuration = 300`.
4. Run staging smoke tests for short transcript, segmented, whole-meeting fallback, and insight-failure paths.
5. Run a live-model fixture evaluation with recorded predictions. The no-argument evaluation remains a label self-check, not live quality evidence.

## Remaining production blockers

- No analysis generation lock/version check; concurrent analyses remain last-writer-wins as explicitly deferred.
- Replacement still resets task rows. Staging blocks replacement only when artifacts/comments exist; preserving all user task edits requires a production graph-merge strategy.
- Whole-graph schema validation can reject an otherwise useful graph because of one invalid object.
- Completed, negated, conditional, and speculative classification remains model-driven.
- Hard graph uniqueness constraints can still reject valid same-title work.
- Inferred status and commitment linkage are not consistently visible across all task UI.
- Live-model extraction quality is not yet enforced by CI.

