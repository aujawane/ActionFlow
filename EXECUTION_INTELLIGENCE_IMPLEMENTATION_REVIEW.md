# Execution Intelligence Implementation Review

**Date:** 2026-07-22  
**Scope:** Commitment-centered execution intelligence vs `TASK_EXTRACTION_AUDIT.md`, `docs/execution-intelligence.md`, migration `20260723010000_add_execution_commitments.sql`, `lib/execution-intelligence/*`, and production analyze/Recall paths.  
**Method:** Code inspection only (no product code changes). Claims were verified against the repository, not documentation trust.

## Validation commands run

| Command | Result |
|---|---|
| `npm test` | **Pass** — 43/43 |
| `npm run lint` | **Pass** — no ESLint warnings/errors |
| `npm run typecheck` | **Pass** |
| `npm run build` | **Pass** |
| `npm run eval:execution` | **Pass** — fixture/label **self-check only** (30 fixtures). Not live model scoring. |

---

## Checklist verdict (code-confirmed)

| Question | Verdict |
|---|---|
| All production meeting-analysis entry points use the new pipeline? | **Yes** — only `POST /api/meetings/[id]/analyze` extracts execution work; Recall webhook + sync-status call that route. |
| Legacy task-only extraction still reachable? | **No** — `extractTopicTasksWithOpenAI` / `buildMeetingTasksPayload` / `insertMeetingTaskRows` are gone from `lib/analysis.ts` and unused in app code. |
| Short meetings use the new pipeline? | **Yes** — short transcript path calls `runExecutionIntelligence` with `fallbackUsed: true`. |
| Whole-meeting fallback persists commitments and tasks? | **Yes** — fallback calls `executeGraph` → `persistExecutionGraph`. |
| Insight failure still permits commitment/task extraction? | **Yes** — per-topic insight failure `continue`s; execution still runs over inserted topics + whatever insights succeeded. |
| Insight `next_steps` enter completeness pass? | **Yes** — `stages.sourcePayload` passes `insight_next_steps`; completeness prompt requires them; pipeline invariant fails closed if next_steps exist and final graph is empty. |
| Topics, summaries, transcript segments, speaker aliases passed correctly? | **Mostly** — topics (id/title/summary/segment_ids), insights, and segment-ID transcript are passed. Speaker aliases are applied to segments before analysis; aliases are **not** passed as a separate structured list. |
| `source_segment_ids` reference real transcript UUIDs? | **Deterministically filtered** — grounding keeps only UUIDs present as `[uuid]` prefixes in the transcript string; invents are stripped; transcript-evidence items with zero valid IDs are rejected. |
| Inferred tasks visibly marked? | **Partial** — marked in `CommitmentsPanel` only; `ExecutionDashboard` / task detail do not show `inferred`. |
| Tasks may exist without commitments? | **Yes** — nullable `commitment_id` / null `commitment_ref`. |
| Commitments may exist without tasks? | **Yes** — schema + UI allow it. |
| One commitment can contain many tasks? | **Yes**. |
| Tasks can safely move between commitments? | **At DB level yes** (`commitment_id` nullable FK, `ON DELETE SET NULL`); **no product API/UI** to reassign. |
| Multiple owners preserved? | **Mostly** — stored in `owners` jsonb; speaker alias updates commitment `owners`, but task alias updates only `owner`, not `owners`. |
| Due dates / `due_date_text` handled correctly? | **Structurally yes** (schema + resolution inherit from parent); correctness of date parsing is model-prompt only. |
| Completed / speculative / negated / conditional treated correctly? | **Prompt-only** — no deterministic post-filters beyond grounding/dedupe. |
| Execution graph replacement truly atomic? | **Yes** — single plpgsql function; deletes then inserts in one transaction. |
| Existing tasks/commitments untouched when extraction fails? | **Yes for graph rows** — persist only on success. **Not true for topics/insights**, which are deleted earlier. |
| Database errors surfaced? | **Yes** — RPC/reload failures return 500 with details; pipeline metrics increment `databaseFailures`. |
| RLS protects `meeting_commitments`? | **Yes** for direct table access — owner policy via `meetings.user_id = auth.uid()`. |
| PATCH commitment verifies meeting ownership? | **Yes**. |
| Speaker alias changes update commitments and tasks? | **Partial** — commitments (`owner` + `owners`) and task `owner` only. |
| Task/topic deletion unintentionally cascade into commitment loss? | **Topic delete: no** (`ON DELETE SET NULL`). **Task delete: no**. **Re-analyze replace: yes intentional wipe** of all tasks (and cascaded artifacts/comments). |
| Retrying same meeting creates duplicates? | **No** — replace deletes meeting graph first. |
| Concurrent analysis can overwrite newer results? | **Yes** — no lock/version; last successful RPC wins. |
| Model schema validation can discard entire graph for one invalid object? | **Yes** — Zod `safeParse` on the whole graph; one bad item fails the stage (retry once). |
| All model stages have timeouts, retries, structured logging? | **Retries + logging: yes (2 attempts).** **Timeouts: no.** |
| Four model calls can exceed Vercel limits? | **Yes risk** — 4 sequential calls × up to 2 attempts; route `maxDuration = 300`. |
| Frontend supports meetings created before migration? | **Partial** — missing `meeting_commitments` table soft-fails; selecting new task columns without migration surfaces a load error and empty tasks. |

---

## 1. Confirmed implementation claims

1. **Single production extraction entry point**  
   Manual analyze (`components/meeting-actions.tsx`), Recall webhook, and sync-status all reach `POST /api/meetings/[id]/analyze`, which exclusively calls `runExecutionIntelligence`.

2. **Legacy task-only OpenAI extraction removed from the live path**  
   `lib/analysis.ts` now exports transcript helpers, topic segmentation, insight analysis, and insight payload builders only.

3. **Audit P0s addressed in orchestration**
   - Whole-meeting fallback runs execution persistence (no longer returns empty tasks by design).
   - Short meetings still extract execution work.
   - Topic insight failure no longer skips execution for that meeting.
   - Insight `next_steps` are inputs to completeness and guarded by an invariant.

4. **Pipeline shape matches docs**  
   Candidates → verify → link/resolve → ground/dedupe → completeness → final verify → ground/dedupe → atomic persist.

5. **Grounding filters invented segment IDs**  
   `enforceExecutionGraphGrounding` parses real UUIDs from the segment-prefixed transcript and rejects transcript-evidence objects lacking valid IDs / quote grounding.

6. **Atomic replace RPC**  
   `replace_meeting_execution_graph` deletes tasks then commitments, re-inserts from JSON, maps `commitment_ref` → UUID, and runs as one plpgsql transaction with `search_path = public`.

7. **Schema supports commitment-centric model**  
   Commitments table + optional `meeting_tasks.commitment_id`, `owners`, `due_date_text`, `source_segment_ids`, `inferred`, `extraction_metadata`; `topic_id` nullable with `ON DELETE SET NULL`.

8. **PATCH `/api/commitments/[id]` ownership check**  
   Loads commitment → verifies `meetings.user_id = auth.user.id` → updates.

9. **RLS enabled on `meeting_commitments`** with owner `FOR ALL` using/check against parent meeting.

10. **Observability prefix and metrics exist** (`[execution-intelligence]` stage + summary logs).

11. **Offline harness exists** (30 fixtures, unit tests for dedupe/grounding/pipeline mock path).

12. **UI commitments panel** renders commitments and linked steps, including an `inferred` label on linked tasks.

---

## 2. Claims that are only partially implemented

1. **“Speaker resolution” as a pipeline stage** (`docs/execution-intelligence.md` mermaid)  
   Aliases are applied to transcript text before analyze. There is no dedicated speaker-resolution stage inside `runExecutionIntelligence`. Alias application to persisted owners is a separate API flow.

2. **Inferred tasks are “visibly marked”**  
   Only in `CommitmentsPanel`. Main execution dashboard and task workspace do not surface `inferred`.

3. **Multiple owners preserved end-to-end**  
   Extraction/persistence store `owners`. Speaker-alias updates refresh commitment `owners` but **task `owners` arrays are not updated** (only `meeting_tasks.owner`).

4. **Completed / speculative / negated / conditional handling**  
   Present in prompts and expected in verification/completeness behavior; **not enforced by deterministic code**. Quality depends entirely on the model.

5. **Due-date correctness**  
   Schema + inheritance from parent commitment exist; ISO parsing / relative-date resolution is not deterministic beyond prompt instructions and `nullableDate` validation.

6. **“Previous graph preserved until replacement”**  
   True for commitments/tasks. **False for topics and insights**, which are deleted before execution succeeds (segmented path and fallback).

7. **Pre-migration / legacy meeting UI compatibility**  
   Missing commitments table is tolerated. Selecting new task columns (`owners`, `inferred`, etc.) against an unmigrated `meeting_tasks` table fails the tasks query and shows a load-error banner with empty task UI.

8. **Evaluation proves extraction quality**  
   `npm run eval:execution` without predictions is a **label self-check**, not evidence that live model output meets MVP thresholds.

9. **Tasks can move between commitments**  
   DB allows it; product has no move/reassign endpoint or UI.

10. **Structured logging is “useful” for all stages**  
    Candidate success and persistence failure log; verification/completeness failures mostly return errors without equally rich stage logs for every failure path.

---

## 3. Incorrect or unsafe claims

1. **Unsafe to claim migration is production-ready without apply + grants review**  
   Migration does not `GRANT EXECUTE` on `replace_meeting_execution_graph`, does not revoke public execute, and has **no ownership check** inside the RPC. App uses service role today (bypasses RLS), so function security relies on server-only calling conventions—not defense in depth.

2. **Unsafe to claim “no data loss on analysis failure”**  
   Extraction failure preserves old commitments/tasks, but topics/insights may already be wiped/replaced. Fallback deletes topics/insights before execution.

3. **Unsafe to claim reprocessing is lossless for user work**  
   Atomic replace **deletes all meeting tasks**, which **cascades** to `task_artifacts` and `task_comments`. Re-analyze destroys deliverables and clarification history.

4. **Docs imply deterministic rejection of completed/negated/speculative work**  
   Implementation is prompt-guided verification only; grounding does not classify completion/negation.

5. **Unique commitment dedupe index is not a safe semantic dedupe layer**  
   DB unique on `(meeting_id, lower(title), coalesce(owner,''))` can abort an entire atomic replace for two legitimate same-title/same-owner commitments, even after app-level soft dedupe.

6. **“All model stages have timeouts” is false**  
   OpenAI calls have retries, not request timeouts.

---

## 4. Migration risks

File: `supabase/migrations/20260723010000_add_execution_commitments.sql`

### Foreign keys / ON DELETE

| Relation | Behavior | Risk |
|---|---|---|
| `meeting_commitments.meeting_id → meetings` | `ON DELETE CASCADE` | Expected |
| `meeting_commitments.topic_id → meeting_topics` | `ON DELETE SET NULL` | Good — topic wipe no longer destroys commitments |
| `meeting_tasks.commitment_id → meeting_commitments` | `ON DELETE SET NULL` | Good — commitment delete orphans tasks, does not cascade-delete them |
| `meeting_tasks.topic_id` recreated | `ON DELETE SET NULL` (was CASCADE) | **Critical improvement**; must be applied before new analyze topic deletes |
| Task artifacts/comments → tasks | existing `ON DELETE CASCADE` | Re-analyze replace deletes tasks ⇒ **wipes artifacts/comments** |

### Indexes / uniqueness

- Meeting/topic/status indexes: fine.
- `meeting_commitments_dedupe_idx` unique: can cause hard RPC failure on near-duplicate titles.
- Existing `meeting_tasks_dedupe_idx` on `(meeting_id, topic_id, task_type, lower(task))` remains and can similarly abort inserts after `topic_id` became nullable (Postgres treats NULLs as distinct, so null-topic duplicates may still insert).

### RLS

- Owner policy present and correctly scoped to meeting owner.
- Service role bypasses RLS (current app pattern).

### Grants / SECURITY DEFINER / search_path

- Function is **SECURITY INVOKER** (default), `SET search_path = public` ✅.
- **No SECURITY DEFINER** ✅ for privilege escalation avoidance.
- **No ownership check** on `p_meeting_id` ❌.
- **No GRANT/REVOKE** for `authenticated`/`anon`/`service_role` ❌ — behavior depends on Supabase default privileges.
- **No JSON parameter validation** beyond table CHECKs; bad enums/dates fail mid-loop and roll back (atomic, but opaque).

### Transaction behavior

- Entire replace is one function call ⇒ atomic ✅.
- Deletes happen first ⇒ failure after delete rolls back ✅.
- Successful replace still destroys dependent task rows by design.

### Other SQL issues

- `commitment_refs` map keyed by `client_ref`; duplicate client_refs silently overwrite.
- Invalid UUID strings in JSON cause cast errors and full rollback.
- Status mapping from `completion_state` → task-like `status` is opinionated (`cancelled` → `dismissed`).

---

## 5. Authentication / RLS risks

1. **PATCH commitment** correctly checks meeting ownership before update via admin client. Good.

2. **Analyze route** allows trusted internal secret without user scoping (`userId` null) — intentional for Recall, but secret compromise can analyze any meeting id.

3. **`replace_meeting_execution_graph`**
   - Called only through `supabaseAdmin` today.
   - If EXECUTE is available to `authenticated`/`anon`, an invoker with meeting access could replace graphs; without ownership check, a buggy grant could be worse.
   - Recommend: `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon;` grant only to `service_role` (or security definer with explicit ownership assert).

4. **RLS on commitments** is correct for direct client access; it does not protect admin-RPC misuse.

---

## 6. Data-loss risks

| Scenario | Effect |
|---|---|
| Execution stage fails after topic/insight reset | Old commitments/tasks kept; summaries/topics may be gone or partial |
| Execution succeeds | Full replace of commitments/tasks; **artifacts/comments deleted** |
| User deletes a topic | Commitments/tasks keep rows, `topic_id` null (after migration) |
| User deletes a task | Commitment remains |
| User deletes a commitment | Tasks remain with `commitment_id` null |
| Concurrent re-analyze | Last writer wins; intermediate user edits to tasks/commitments overwritten |
| Unique-index collision during replace | Whole replace fails; prior graph remains (good), but analyze returns 500 |
| Migration not applied | Analyze RPC fails; UI task select with new columns fails |

---

## 7. Concurrency risks

1. **No meeting-level analysis lock / generation token / `updated_at` compare.**  
   Two overlapping analyze calls both compute graphs; whichever RPC finishes last overwrites the other.

2. **No protection for in-flight user edits** (owner changes, deliverables, comments) during re-analyze.

3. **Recall + manual Analyze** can race on the same meeting.

4. Topic/insight deletes are not versioned with the graph replace, so concurrent readers can observe empty summaries while old tasks still exist.

---

## 8. Model reliability risks

1. **Four sequential model calls** (candidates, verify, completeness, final verify), each with **up to 2 attempts** and **no timeout** ⇒ high latency / hard kill at Vercel 300s.

2. **Whole-graph Zod validation** — one malformed object fails the stage; no per-item salvage.

3. **Strict JSON schema** helps structure, but still allows semantically wrong open commitments.

4. **Prompt-only policy** for negation/completion/speculation/conditionals.

5. **Aggressive linker** (`linkTasksToCommitments` score ≥ 0.6) can attach independent tasks to loosely similar commitments.

6. **Completeness invariant** fails the entire run if insight next_steps exist and final graph is empty — preserves old graph (good) but can block updates when the model under-extracts.

7. **Eval gap** — no CI gate on live model predictions; current eval is reference self-check.

8. **Retries only twice**; transient OpenAI outages still fail closed after ~2 tries per stage.

---

## 9. UI compatibility risks

1. Meetings without commitments render no commitments panel (`return null`) — fine for legacy meetings with tasks only.

2. Unmigrated DB:
   - Commitments query soft-handles missing relation.
   - Tasks query requests new columns and will error if columns absent.

3. Execution dashboard still task-centric; no commitment grouping there.

4. Inferred badge limited to commitments panel.

5. Speaker-mapping success copy mentions transcript/task owners, not commitments (behavior does update commitments).

6. Task detail page does not mention commitment parent / inferred flag.

---

## 10. Required fixes before staging

1. **Apply migration** to the staging Supabase project and verify RPC callable by the app service role.

2. **Harden RPC privileges:** revoke public/anon execute; grant only to the role the server uses; add `auth`/ownership assertion or keep strictly service-role-only.

3. **Soft-select new task columns** (or feature-detect missing columns) so pre-migration staging DBs do not blank the tasks UI.

4. **Add OpenAI timeouts** per stage and fail with structured metrics (do not hang until platform kill).

5. **Document/operate on artifact wipe:** either snapshot/preserve artifacts across replace, or block re-analyze when deliverables exist, or warn in UI.

6. **Update task `owners` on speaker alias changes** (parity with commitments).

7. **Run at least one live-model eval** against fixtures (predictions file) and record scores; do not treat self-check as quality proof.

8. **Manual smoke** of short-meeting, fallback, insight-failure, and successful segmented paths on staging data.

9. Confirm `maxDuration=300` is actually available on the target Vercel plan.

---

## 11. Required fixes before production

1. Everything in §10.

2. **Concurrency control** for analyze (row lock, `analysis_run_id`, or compare-and-swap generation number) so overlapping runs cannot clobber newer graphs.

3. **Preserve or migrate user-generated task state** on replace (artifacts, comments, status edits, owners) or make re-analyze additive/merge-based for user-touched rows.

4. **Relax or remove hard unique commitment index** (or make replace upsert/dedupe before insert) so legitimate multi-commitment graphs do not 500.

5. **Per-item validation salvage or repair loop** so one bad candidate does not discard an otherwise valid graph after retries.

6. **Deterministic filters** (or stronger tests with recorded model I/O) for completed/negated/speculative statements.

7. **Surface `inferred` and commitment linkage** in execution dashboard / task pages.

8. **Latency budget plan:** batch/combine stages for short meetings; consider parallel topic-scoped candidates later; alert when stage latency approaches budget.

9. **RPC ownership check** even for service role callers that pass user context, if any non-admin path can invoke it.

10. **Do not ship** relying solely on prompt behavior for completeness of insight next_steps without live eval gates in CI.

---

## 12. Exact manual test plan

### A. Preconditions

1. Apply `20260723010000_add_execution_commitments.sql` to the target DB.
2. Confirm `\df+ replace_meeting_execution_graph` exists; confirm app service role can execute it.
3. Confirm env: `OPENAI_API_KEY`, `RECALL_WEBHOOK_SECRET`, app URL, Supabase service role.
4. Deploy/build the branch under test (`npm run build` already green locally).

### B. Entry points

1. **Manual Analyze** on a meeting with a long transcript → expect topics + insights + commitments + tasks; response includes `execution_metrics`.
2. **Recall webhook / sync-status** on a completed bot → confirm it hits analyze and persists a graph (check logs for `[execution-intelligence]` and `[recall-processing] Analysis response`).
3. Confirm no code path still inserts tasks without the RPC (DB: only new rows after analyze should appear via replace).

### C. Short meeting

1. Meeting with &lt;2 segments or &lt;25 words.
2. Analyze → `skipped: true` but `commitments`/`tasks` populated when transcript has actionable content.
3. Confirm topics/insights may be empty.

### D. Whole-meeting fallback

1. Force fallback (e.g., temporarily break segmentation or use a transcript that yields zero topics).
2. Confirm fallback reason returned, commitments/tasks persisted, topics empty or reset.

### E. Insight failure does not block execution

1. Use a multi-topic meeting; simulate/observe a topic insight OpenAI failure (or revoke key mid-run in a controlled staging experiment).
2. Confirm warn logs and that execution still runs for remaining context.

### F. Insight next_steps completeness

1. Meeting whose insight next_steps include an action absent from candidate stage (inject via fixture-like transcript if needed).
2. Confirm completeness stage metrics `missing_*` can increase and final graph includes the work **or** run fails closed without wiping prior graph if invariant trips.

### G. Grounding / segment IDs

1. After analyze, SQL/API-check `source_segment_ids` ⊆ `transcript_segments.id` for that meeting.
2. Confirm invented IDs are not stored.

### H. Cardinality / linkage

1. Commitment with multiple linked tasks visible in Commitments panel.
2. Standalone task with `commitment_id IS NULL` still appears in execution dashboard.
3. Commitment with zero tasks shows the empty-steps message.

### I. Owners / due dates / inferred

1. Multi-owner language (“Aditya and Craig will…”) → both in `owners`.
2. Relative due language preserved in `due_date_text`; ISO only when resolvable.
3. Inferred steps show `inferred` badge in Commitments panel.
4. Change speaker alias → commitment owner/owners and task owner update; verify task `owners` array behavior (expect gap today).

### J. Statement classes

Use transcripts containing:
- already completed work
- “we should maybe…”
- “don’t send X”
- “if legal approves, then…”
Confirm model output (spot-check) matches policy; log failures as model-quality bugs.

### K. Failure preserves graph

1. Seed a meeting with known commitments/tasks.
2. Force execution model failure (invalid key / mock 502).
3. Confirm old commitments/tasks unchanged.
4. Separately note whether topics/insights were cleared.

### L. DB error surfacing

1. Drop/rename RPC temporarily in staging.
2. Analyze → HTTP 500 with persistence error details; metrics `databaseFailures`.

### M. Auth / RLS / PATCH

1. As owner: PATCH commitment succeeds.
2. As other user: PATCH returns 404/unauthorized style not-found.
3. Direct Supabase client as user can only read/write own meeting commitments.

### N. Cascade / delete behavior

1. Delete a topic → commitments/tasks remain, `topic_id` null.
2. Delete a task → commitment remains.
3. Delete a commitment → tasks remain with null `commitment_id`.
4. Re-analyze after creating a deliverable/comment → confirm whether artifact/comment is deleted (expected current behavior: deleted).

### O. Retry / concurrency

1. Analyze twice sequentially → no duplicate commitments/tasks for same meeting (counts replace, not append).
2. Fire two concurrent Analyze requests → inspect final graph; document last-writer-wins.
3. Edit a task owner mid-flight of a second analyze → confirm overwrite risk.

### P. Pre-migration UI (separate environment)

1. Against DB **without** migration: open old meeting page.
2. Confirm commitments section degrades; document tasks query failure until migration applied.

### Q. Runtime budget

1. Large multi-topic meeting; record `execution_metrics.openAiLatencyMs` sum + wall clock.
2. Confirm completion under 300s; if not, treat as release blocker for that meeting class.

---

## Summary judgment

The redesign **does** re-center production analysis on a commitment→task pipeline, closes the audit’s worst orchestration holes (fallback empty tasks, insight-failure skip, short-meeting skip, next_steps ignored), and ships an atomic replace RPC with grounding/dedupe and ownership-aware commitment PATCH/RLS.

It is **not yet production-safe** without: migration privilege hardening, concurrency control, protection of user-generated task artifacts/comments across replace, live model evaluation, request timeouts, and UI/query compatibility for unmigrated or legacy meetings. Staging can proceed after §10; production should require §11.
