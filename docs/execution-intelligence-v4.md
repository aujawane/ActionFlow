# Execution Intelligence V4

V4 replaces independent task/commitment extraction plus relationship evaluation with a single
architectural move: ground leaves first, then group those same leaves by reference. Commitment is
treated as a graph-level property of a set of grounded work items, never as something extracted
independently and reconciled afterward.

```text
Transcript + Topics
  -> Topic-scoped Work-Item Extraction
  -> Deterministic Merge/Dedup
  -> Holistic Grouping Pass
  -> Verification
  -> Deterministic Tree Assembly and Integrity Validation
  -> Atomic Persistence
  -> Commitments + Child Tasks + Standalone Tasks UI
```

Three model calls (work-item extraction, grouping, verification) instead of the `independent`
engine's four (task extraction, commitment extraction, relationship evaluation, verification).
Relationship evaluation is not replaced by another stage -- it is eliminated. The grouping pass
decides "which work items belong to this outcome" once, with full visibility of every already-
grounded item; there is no second, independent pass re-guessing at purpose afterward.

## Engine flag

```
EXECUTION_INTELLIGENCE_ENGINE=independent | v4
```

Resolved once per generation, at the `topic_extraction` worker stage, and carried through the rest
of that durable run in the job checkpoint's `engine` field (`lib/meeting-analysis/worker.ts`) --
a single generation is never split across two architectures.

- No env var set: `v4` outside `NODE_ENV=production`, `independent` in production.
- Explicit env var always wins, in every environment, including production (set it to `v4` in a
  staging/production environment to compare directly against real meetings).
- See `getExecutionIntelligenceEngine()` in `lib/env.ts`.

Both engines persist into the same `meeting_commitments` / `meeting_tasks` tables through the same
`persistExecutionGraph` RPC call -- no schema migration. V4's tree is flattened to that legacy
shape only at the persistence boundary (`execution-graph-v4.ts:treeToExecutionGraph`); the tree
itself, not the flattened shape, is V4's authoritative output.

### Removing the `independent` engine

Once `v4` has run against a meaningful sample of real meetings in production (via the explicit env
override) and its commitment/task quality has been reviewed against `independent` output for the
same meetings, flip the production default in `getExecutionIntelligenceEngine()` to `v4`,
run both engines in parallel for one further review cycle, and then:

1. Delete `lib/execution-intelligence/independent-execution.ts`,
   `lib/execution-intelligence/independent-pipeline.ts`, and the `independent`-only branches in
   `lib/meeting-analysis/worker.ts` and the dev debug route.
2. Delete the already-deprecated V2/V3 remnants these superseded:
   `lib/execution-intelligence/execution-v2.ts`, `consolidation.ts`, `linking.ts`, and the
   V2-only prompts in `prompts.ts` (`CANDIDATE_GENERATION_PROMPT`, `VERIFICATION_PROMPT`,
   `COMPLETENESS_PROMPT`, `GLOBAL_SYNTHESIS_PROMPT`, `EXECUTION_JUDGE_PROMPT`) once
   `tests/execution-intelligence-v2.test.ts` is retired alongside them.
3. Remove `EXECUTION_INTELLIGENCE_ENGINE` and `resolveEngine()` entirely; `v4` becomes the only
   path.

## Data structures (`work-item-schemas.ts`)

A `WorkItem` is a grounded leaf. It has no commitment reference, relationship field, or promotion
metadata -- those concepts don't exist at this layer:

```ts
type WorkItem = {
  ref: string;                 // assigned by application code, never the model
  title: string;
  description: string | null;
  owner: string | null;
  owners: string[];
  requester: string | null;
  recipient: string | null;
  due_date: string | null;
  due_date_text: string | null;
  status: "open" | "in_progress" | "blocked" | "completed" | "non_execution";
  classification: "open_task" | "accepted_request" | "assignment" | "promise" | "reminder"
    | "scheduling" | "completed_work" | "in_progress" | "request" | "decision" | "proposal"
    | "idea" | "question" | "blocker";
  source_quote: string;
  source_segment_ids: string[];
  topic_id: string | null;
  extraction_reason: string;
  confidence: number | null;
};
```

A `GroupProposal` is a commitment, defined by which leaves it claims -- never by its own
independent evidence, except in the one explicitly-licensed zero-member case:

```ts
type GroupProposal = {
  ref: string;                 // assigned by application code
  title: string;
  description: string | null;
  owner: string | null;
  owners: string[];
  due_date: string | null;
  due_date_text: string | null;
  member_refs: string[];       // [] is valid
  purpose_reason: string;
  scope_added_beyond_members: string | null;   // required non-vacuous when member_refs.length <= 1
  zero_member_evidence: { source_quote: string; source_segment_ids: string[] } | null;
};

type ExecutionTree = {
  commitments: Array<GroupProposal & { tasks: WorkItem[] }>;
  standalone_tasks: WorkItem[];   // the computed complement, never a modeled field
};
```

The model never emits a `ref` for either type. Application code assigns work-item refs once,
immediately after the deterministic merge (`work-item-merge.ts`), and group refs once per model
call that proposes a group set (`execution-tree.ts:assignDraftGroupRefs`). This is the same
identity-ownership rule already used for Conversation Events
(`conversation-event-identity.ts`) and V3's task/commitment refs.

## Runtime pipeline and files

| Stage | File | What it does |
| --- | --- | --- |
| Work-item extraction | `work-item-prompts.ts` (`WORK_ITEM_EXTRACTION_PROMPT`), `work-item-stages.ts` (`extractTopicWorkItems`) | Topic-scoped, chunked, parallel. Reuses the proven topic-scoping strategy from V3's `extractTopicActions`. The model never sees or reasons about commitments. |
| Deterministic merge | `work-item-merge.ts` (`mergeTopicWorkItems`) | Canonicalizes refs (`wi_1`, `wi_2`, ...), deduplicates repeated mentions, never merges across a classification or status boundary. |
| Grouping | `work-item-prompts.ts` (`GROUPING_PROMPT`), `work-item-stages.ts` (`runGroupingPass`) | The one holistic pass: given every grounded work item at once, proposes which refs share a purpose and names it. Cannot invent evidence -- a non-zero-member group's evidence is its members', by construction. |
| Verification | `work-item-prompts.ts` (`GROUPING_VERIFICATION_PROMPT`), `work-item-stages.ts` (`runGroupingVerificationPass`) | One pass over work items + proposed groups. May keep/correct/remove a group, correct a work item's owner/status, or add at most one missed explicit zero-member commitment. May not invent new work, evidence, or theme-based commitments. |
| Deterministic assembly | `execution-tree.ts` (`assembleExecutionTree`) | The only place a group is finally accepted, rejected, or demoted, and the only place "standalone" is decided. Enforces: each member ref resolves to an active work item; each work item claimed by at most one group (first-claim-wins); zero-member groups require valid evidence; single-member groups require a non-vacuous `scope_added_beyond_members`; unclaimed active items become standalone automatically. |
| Persistence | `execution-graph-v4.ts` (`treeToExecutionGraph`), reuses `persistence.ts` unchanged | Flattens the tree to the legacy `ExecutionGraph` shape and persists through the existing atomic RPC. |

Durable job stage names are unchanged (`candidates`, `verification`, `completeness`,
`final_verification`, `synthesis`) to avoid a queue schema migration; their V4 meaning is
extraction+merge, grouping, grouping verification, deterministic assembly, and trace
finalization, respectively -- the same "reuse the job key, change what runs" pattern already used
for the V2 and V3 remaps documented in `execution-intelligence-v2.md` and
`independent-execution.md`.

## What's excluded from the V4 runtime path

By construction, not by removal: V4 never imports `independent-execution.ts`, `execution-v2.ts`,
`consolidation.ts`, or `linking.ts`. There is no relationship-evaluation model call, no
responsibility ledger, no execution-intent compatibility graph, no outcome clustering, no
promotion gate or judge, no action-verb demotion, no accepted-work repair, no hierarchy
consolidation, and no quote-similarity grounding deletion in the V4 pipeline. These modules remain
importable for the `independent` engine and old tests only; see "Removing the `independent`
engine" above for when to delete them outright.

## Debug endpoint

`/api/dev/meeting-extraction-debug?meetingId=<uuid>` now returns `engine` (`"independent"` or
`"v4"`) alongside both `independent_execution` and `execution_tree_v4` trace objects (whichever
one the meeting's last generation actually ran populates; the other is `null`). The V4 trace's
`commitments_debug` and `work_items_debug` arrays merge each item with its verification/grouping
decision in one row -- `member refs`, `purpose_reason`, `scope_added_beyond_members`,
`zero_member_evidence`, and keep/remove/demote reason per commitment; claimed group ref,
child/standalone/excluded disposition, and reason per work item.
