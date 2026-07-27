# TODO

Prioritized for AI agents. Update when work lands or new debt appears.

## High Priority

- [ ] Apply / verify staging migrations through `20260727120000_add_commitment_people.sql` (never apply to production until gated)
- [ ] Re-analyze the real Jamileh staging meeting and persist the new synthesis; read-only preview changed 20 commitments / 43 tasks to 1 synthesized commitment / 12 tasks without writing
- [ ] Clear live-eval hallucination threshold gate before production graph/classification rollout (`PRODUCTION_READINESS_REPORT.md`)
- [ ] Confirm background worker chaining reliability under Vercel Pro (`maxDuration` 300, `after()` hops, internal secret)

## Medium Priority

- [ ] Tune global synthesis latency/variance; the real Jamileh preview needed 48–90 seconds per model attempt
- [ ] Calibrate conversation-level outcome domains/breadth thresholds against more real meetings
- [ ] Strengthen inferred-task discipline in prompts + consolidation (no ceremony steps without evidence)
- [ ] Keep `supabase/schema.sql` from misleading agents — either regenerate baseline or document “migrations only” everywhere (partially done in PROJECT_CONTEXT)
- [ ] Observability: richer job failure UX/retry for stuck `meeting_analysis_jobs`
- [ ] Ensure follow-up emails never include non-committed items unless user explicitly selects them (verify all generate paths)

## Low Priority

- [ ] Remove or archive root audit markdown once superseded by docs memory (`TASK_EXTRACTION_AUDIT.md`, old EI reports)
- [ ] Migrate off deprecated `next lint` when upgrading Next 16 tooling
- [ ] Dev-only recall debug routes: confirm not exposed/usable in production builds
- [ ] No in-code `TODO`/`FIXME` comments found at doc creation — prefer tracking here

## Done recently (do not re-open without cause)

- [x] Commitment-first consolidation stage
- [x] Background analysis jobs + 202 analyze
- [x] Meeting UI reorder + Ideas panel
- [x] Committed-only follow-up filtering (primary path)
- [x] Re-analysis UUID/artifact/comment preservation RPC
- [x] First-class projects + manual meeting assignment
- [x] Project overview and dedicated milestone workspace
- [x] Explicit task dependencies + next-best-task ranking
- [x] Hierarchical commitment-to-milestone consolidation
- [x] Global conversation-level commitment synthesis worker stage
- [x] Task-level owner resolution and owner-grouped commitment workspace
- [x] Re-analysis-safe manually curated commitment participants
- [x] Meeting page task-library deduplication
