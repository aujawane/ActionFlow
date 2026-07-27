# DECISIONS

Engineering decisions for AI agents. Update when you make a new one.

## D001 — Next.js App Router on Vercel (not Docker app)

**Decision:** Host Parfait as Next.js on Vercel Pro; keep Supabase/OpenAI/Recall external.  
**Why:** Fits auth SSR, API routes, and existing stack; Dockerizing the Next app was explicitly rejected for this deploy.  
**Tradeoff:** Function timeouts force durable stage chaining for analysis.

## D002 — Supabase Auth + service-role server access

**Decision:** Browser uses anon SSR client; server routes often use `supabaseAdmin` with explicit ownership checks.  
**Why:** Webhooks, Recall, and graph RPCs need elevated access; RLS alone is insufficient for bots/workers.  
**Security:** Never expose service role; RPC execute granted to `service_role` only for graph replacement.

## D003 — Commitments → Tasks → Deliverables model

**Decision:** Commitments are primary execution objects; tasks are distinct steps; deliverables are workspace outputs.  
**Why:** Flat task lists were overwhelming and duplicative.  
**Implication:** UI and metrics prioritize commitments; tasks may be zero under a commitment.

## D004 — Background analysis via DB jobs + self-chaining worker (not Workflow SDK)

**Decision:** `meeting_analysis_jobs` + `POST /api/internal/meeting-analysis/worker` with `after()` chaining.  
**Why:** Vercel Workflow SDK broke `next build` (well-known workflow page collection). DB checkpoints survive hop boundaries.  
**Rejected:** Inline full pipeline in analyze route (timeouts); Workflow SDK dependency.

## D005 — Deterministic consolidation after LLM, before persistence

**Decision:** Merge duplicates/restatements in code (`consolidation.ts`), not another full-meeting LLM pass.  
**Why:** Cheaper, stable, reduces UI load; quality signal ~6–10 commitments / 12–20 tasks (not hard truncation).  
**Tradeoff:** Possible rare false merges; tune similarity/phase markers carefully.

## D006 — `execution_classification` separates ideas from work

**Decision:** Enum `committed | proposed | requirement | future_consideration`; only committed in queue/emails/owner load.  
**Why:** Model mixed brainstorming with promises.  
**Default:** Missing classification salvaged to `committed` for backward compatibility.

## D007 — Atomic merge persistence with generation lock

**Decision:** `replace_meeting_execution_graph` matches existing UUIDs; preserves artifacts/comments/manual overrides; rejects stale generation.  
**Why:** Destructive delete/reinsert destroyed user work on re-analyze.  
**Do not:** Reintroduce wipe-and-replace or weaken stale checks.

## D008 — Bounded OpenAI calls (timeouts, limited retries)

**Decision:** Per-stage timeouts (`EXECUTION_INTELLIGENCE_TIMEOUT_MS`), ~2 app-level attempts, SDK retries off for EI calls.  
**Why:** Hung model calls burned entire Vercel invocations.  
**Do not:** Raise timeouts as a substitute for chunking/batching.

## D009 — Chunked candidates + batched verification

**Decision:** Long transcripts split for candidate extraction; verification batched.  
**Why:** Full-meeting single-shot failed latency/token limits.  
**See:** `chunking.ts`, `graph-batching.ts`.

## D010 — Zoom S2S vs Google user OAuth

**Decision:** Zoom uses Server-to-Server OAuth (no browser callback); Google Meet uses per-user OAuth tokens in `user_integrations`.  
**Why:** Matches each vendor’s meeting-creation model.

## D011 — Migrations over `schema.sql` as source of truth

**Decision:** Evolve via `supabase/migrations/*`; treat `schema.sql` as historical baseline.  
**Why:** Baseline lags features (tasks, commitments, jobs, classification).  
**Ops:** Do not apply new production migrations until readiness gate clears.

## D012 — AI project memory in `docs/`

**Decision:** Maintain `PROJECT_CONTEXT`, `ARCHITECTURE`, `FILE_INDEX`, `CHANGELOG_AI`, `DECISIONS`, `TODO` for agent context.  
**Why:** Minimize full-repo scans; keep durable knowledge.  
**Rule:** Update these after every completed task that changes behavior/scope.

## D013 — Projects are manual, meeting-sourced containers in v1

**Decision:** `meetings.project_id` is the assignment source of truth; commitment/task `project_id` is denormalized and synchronized atomically.  
**Why:** Enables fast project rollups without trusting model output.  
**Deferred:** Automatic meeting linking and cross-meeting milestone merging.

## D014 — Explicit task dependency DAG

**Decision:** Store blockers in normalized `task_dependencies`, reject self/cyclic edges, and rank only tasks whose prerequisites are complete.  
**Why:** Status and suggested steps cannot safely drive “next best task.”  
**Safety:** Manual task merges repoint dependency edges and preserve artifacts/comments.

## D015 — Commitments mean milestones

**Decision:** Prompts produce substantial outcomes; a deterministic second consolidation pass converts grounded narrower commitments into child tasks only when a broader compatible milestone exists.  
**Why:** Avoid dozens of overlapping “commitments” for one initiative.  
**Tradeoff:** Domain and breadth heuristics are conservative; staging quality must be measured before production rollout.

## D016 — Global synthesis owns the final commitment hierarchy

**Decision:** Chunked extraction/verification gathers evidence, but one meeting-wide model checkpoint synthesizes the final conversation-level outcomes before deterministic consolidation and atomic persistence.  
**Why:** Merging chunk-level commitment candidates alone still produced action-level peers (20 commitments / 43 tasks in the Jamileh meeting).  
**Supersedes:** D005's “no full-meeting LLM pass” restriction; deterministic consolidation remains the final safety net.  
**Guardrails:** More than seven committed outcomes emits a fragmentation warning; narrow and non-committed pseudo-commitments demote to tasks; task owners never inherit automatically from the lead.

## D017 — Explicit people, derived participation

**Decision:** Store manual commitment participants in `commitment_participants`; derive the rest from the lead, child task owners, reviewers, and input providers at read time.  
**Why:** Arrays cannot distinguish manual intent from regenerated evidence, while a join table survives graph replacement when commitment identity is preserved.  
**Safety:** Adding/removing a participant marks the commitment protected for re-analysis; do not include every meeting attendee automatically.
