# Production Readiness Report

**Date:** 2026-07-23  
**Scope:** Commitment-centered execution intelligence production hardening  
**Production migration applied:** **No**

## Readiness decision

The graph persistence and application changes are production-safety ready for
staging migration verification: re-analysis preserves user work, stale runs are
rejected, model requests are bounded, malformed model items are salvaged, RPCs
are server-only, and execution provenance is visible.

The live-model quality gate is **not fully green**. The final 30-fixture run
passed commitment/task precision and recall thresholds but exceeded the
hallucination threshold. Production rollout should remain gated until that
metric is accepted or improved with a separate prompt/model-quality change.

## Changes made

### Data preservation

- Replaced destructive delete/reinsert semantics with an atomic merge RPC.
- Cross-run matching uses transcript segment overlap, quote similarity, and
  title similarity, then supplies validated existing row UUIDs to PostgreSQL.
- Matched tasks retain UUIDs, so `task_artifacts` and `task_comments` remain
  attached.
- Manual status, owner, owner-array, due-date, and due-date-text overrides are
  tracked and preserved.
- Task-chat patches, owner edits, commitment edits, and speaker-alias owner
  changes mark the affected fields as manual overrides.
- Unmatched tasks are deleted only when they are untouched and have no artifact
  or comment rows. Existing pre-tracking rows are conservatively protected.

### Concurrency

- Added monotonic `meetings.execution_graph_generation`.
- Each analysis claims a generation before model work.
- Persistence locks the meeting row and rejects any stale or already-persisted
  generation before changing graph rows.
- Stale results return HTTP 409 and leave the newer graph intact.

### Database security and constraints

- Both generation-claim and graph-merge RPCs retain
  `SET search_path = public`.
- Execute is revoked from `PUBLIC`, `anon`, and `authenticated`; only
  `service_role` is granted execute.
- Meeting existence/deleted-state and JSON-array inputs are validated.
- Title-based unique commitment/task indexes were replaced by non-unique lookup
  indexes so legitimate same-title work does not abort the transaction.

### Model reliability

- All four execution-intelligence calls use the existing 25-second timeout,
  SDK retries disabled, and two bounded application attempts.
- Commitments and tasks are validated independently.
- Invalid UUID fields are safely repaired; malformed items are dropped without
  discarding valid siblings.
- A stage retries when malformed input contains no salvageable work.
- Structured logs include timeout, retry, validation/salvage, candidate,
  verified, final, and persistence events.

### UI

- Execution dashboard task cards show inferred status and parent commitment.
- Task workspace header shows inferred status.
- Task workspace displays the linked parent commitment.
- Missing optional legacy fields remain non-fatal.

### Live evaluation

- Added `npm run eval:execution:live`.
- The harness supplies deterministic transcript UUIDs, executes the real
  four-stage model pipeline, and mocks persistence.
- Recorded predictions:
  `tests/fixtures/execution-intelligence-live-predictions.json`.

## Principal files changed

- `supabase/migrations/20260723130000_production_execution_graph_safety.sql`
- `lib/execution-intelligence/matching.ts`
- `lib/execution-intelligence/persistence.ts`
- `lib/execution-intelligence/pipeline.ts`
- `lib/execution-intelligence/salvage.ts`
- `lib/execution-intelligence/model.ts`
- `lib/execution-intelligence/observability.ts`
- `lib/execution-intelligence/prompts.ts`
- `lib/execution-intelligence/fixture-harness.ts`
- `lib/manual-overrides.ts`
- `app/api/meetings/[id]/analyze/route.ts`
- `app/api/tasks/[id]/owner/route.ts`
- `app/api/tasks/[id]/comments/route.ts`
- `app/api/commitments/[id]/route.ts`
- `components/execution-dashboard.tsx`
- `components/task-execution-badges.tsx`
- `components/task-workspace-task-state.tsx`
- `app/tasks/[id]/page.tsx`
- `scripts/run-execution-intelligence-live-eval.ts`
- `tests/production-execution-safety.test.ts`

## Automated validation

| Command | Result |
|---|---|
| `npm test` | **Pass — 53/53** |
| `npm run lint` | **Pass — no warnings/errors** |
| `npm run typecheck` | **Pass** |
| `npm run build` | **Pass** |
| `git diff --check` | **Pass** |

The first parallel typecheck overlapped with `next build` and observed transient
missing `.next/types` files. It was rerun after build completion and passed.

## Live-model evaluation result

Final run: 30/30 fixtures completed without transport/stage failures.

| Metric | Result | Threshold | Status |
|---|---:|---:|---|
| Commitment precision | 0.783 | >= 0.70 | Pass |
| Commitment recall | 0.800 | >= 0.75 | Pass |
| Task precision | 0.733 | >= 0.70 | Pass |
| Task recall | 0.750 | >= 0.75 | Pass |
| Owner accuracy | 0.933 | >= 0.70 | Pass |
| Due-date accuracy | 0.967 | >= 0.70 | Pass |
| Grounding accuracy | 1.000 | >= 0.80 | Pass |
| Duplicate rate | 0.000 | <= 0.10 | Pass |
| Hallucination rate | **0.228** | <= 0.15 | **Fail** |
| Completeness score | 0.772 | >= 0.75 | Pass |

The scorer exited non-zero only for hallucination rate. The threshold was not
weakened. Some counted mismatches are title-normalization differences, but the
recording also contains real over-extraction (for example duplicated group or
cross-topic work), so this remains a valid quality risk.

## Migration instructions

Do not apply directly to production.

1. Back up the staging database and record row counts for:
   `meetings`, `meeting_commitments`, `meeting_tasks`, `task_artifacts`, and
   `task_comments`.
2. Apply migrations through
   `20260723130000_production_execution_graph_safety.sql` in staging.
3. Verify columns:

   ```sql
   select column_name
   from information_schema.columns
   where table_schema = 'public'
     and table_name in ('meetings', 'meeting_tasks', 'meeting_commitments')
     and column_name in (
       'execution_graph_generation',
       'last_persisted_execution_generation',
       'preserve_on_reanalysis',
       'manual_override_fields'
     );
   ```

4. Verify privileges:

   ```sql
   select routine_name, grantee, privilege_type
   from information_schema.routine_privileges
   where routine_schema = 'public'
     and routine_name in (
       'claim_meeting_execution_analysis',
       'replace_meeting_execution_graph'
     )
   order by routine_name, grantee;
   ```

   Expected executable grantee: `service_role` only.

5. Verify old unique indexes are absent and new lookup indexes exist:

   ```sql
   select indexname, indexdef
   from pg_indexes
   where schemaname = 'public'
     and tablename in ('meeting_tasks', 'meeting_commitments');
   ```

6. Deploy the matching application build to staging.
7. Run two concurrent Analyze requests for one meeting; confirm the older result
   returns 409 and the latest graph remains.
8. For a task with an artifact, comment, changed status, changed owner, and
   changed due date, re-analyze and confirm the task UUID and all user work are
   unchanged.
9. Confirm untouched omitted extraction tasks may be removed.
10. Compare pre/post row and child-FK counts before scheduling production.

## Rollback steps

Rollback must preserve data and support mixed application versions.

1. Stop new analysis traffic.
2. Before rolling the application back, restore a **service-role-only**
   compatibility overload with the prior three-argument RPC signature. Keep the
   four-argument merge RPC in place until all new application instances drain.
3. Deploy the previous application version.
4. Confirm no callers use `claim_meeting_execution_analysis` or the
   four-argument merge RPC.
5. Revoke and then drop the new RPC overloads only after traffic is drained.
6. Do **not** drop generation, preservation, or override columns during an
   emergency rollback; they are additive and contain safety state.
7. Do **not** recreate the old unique dedupe indexes automatically. Existing
   legitimate duplicates can make index recreation fail or block future writes.
8. If the old destructive RPC must temporarily return, retain its
   service-role-only grants and the previous application’s artifact/comment
   re-analysis block.
9. Reconcile any analysis started during the deployment window before
   re-enabling traffic.

## Remaining risks

1. **Live-model hallucination gate fails** (0.228 vs 0.15). This is the principal
   release blocker.
2. Cross-run matching is heuristic. Ambiguous same-evidence tasks may be inserted
   as new rows; protected older rows are retained rather than destroyed.
3. Conservatively protected legacy tasks can accumulate until reviewed or
   explicitly unprotected.
4. Topic and insight writes are still outside the atomic execution-graph merge;
   concurrent runs can race those derived sections even though stale execution
   graphs cannot overwrite newer graphs.
5. SQL behavior is contract-tested from migration text but still requires a
   real staging Supabase migration/integration test.
6. Full meeting analysis still includes topic/insight OpenAI calls outside this
   execution-stage timeout adapter.
7. Model quality remains nondeterministic; one live run is evidence, not a
   stable guarantee. Preserve the recording and rerun before production.

