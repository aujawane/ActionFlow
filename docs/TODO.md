# TODO

Prioritized for AI agents. Update when work lands or new debt appears.

## High Priority

- [ ] Apply / verify staging migrations through `20260727130000_project_brain_phase1.sql` (never apply to production until gated)
- [ ] Exercise Project Brain proposal apply/rollback/RLS against a staging database and the real Jamileh project
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
- [ ] Add project-native milestones so Project Brain can create execution outcomes before the first meeting; Phase 1 milestones remain meeting-backed

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
- [x] Project Brain structured memory and persistent contextual chat
- [x] Reviewable typed project proposals with explicit per-operation approval
- [x] Version-checked service-role-only atomic proposal application and project audit history
- [x] Approved Project Memory context in future meeting analysis
- [x] Outcome-level Project Brain milestone planning and completeness retry
- [x] Human-readable grouped proposal review with advanced JSON validation
