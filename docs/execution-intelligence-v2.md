# Execution Intelligence V2

Execution Intelligence V2 is Parfait's responsibility-first reasoning layer. It preserves the
existing transcript, topic, insight, Conversation Event, worker, retry, verification, persistence,
and database architecture. It changes the direction of execution reasoning:

```text
Transcript
  -> Conversation Events
  -> Responsibility Extraction
  -> Action Classification
  -> Outcome Clustering
  -> Commitment Promotion
  -> Hierarchy Builder
  -> Execution Judge
  -> Persistence
```

## Compatibility boundary

The database continues to store `meeting_commitments` and `meeting_tasks`. Before hierarchy is
built, a task-shaped object is only a compatibility envelope for a responsibility. Candidate,
verification, and completeness outputs are normalized to `commitments: []` with every
`commitment_ref` set to `null`. Only the meeting-wide synthesis stage may promote clusters.

This avoids a schema migration and keeps existing persistence, matching, manual-edit transfer,
project rollups, and UI consumers working. The durable worker stage names remain unchanged, so
queued and retrying jobs remain compatible.

## Stage decisions

### Responsibility extraction

The candidate model has one job: preserve distinct responsibilities without summary, clustering,
hierarchy, inferred implementation ceremony, or strategic naming. Conversation Events remain the
primary execution evidence. Linked request/acceptance records describe one responsibility.

### Action classification

Responsibilities use the existing graph fields as a storage adapter:

| V2 meaning | Compatibility representation |
| --- | --- |
| Accepted/explicit open work | `execution_classification=committed` |
| Proposal | `proposed` |
| Decision or unowned requirement | `requirement` |
| Future idea | `future_consideration` |
| Responsibility action/signal | Preserved in description plus event provenance |
| Responsibility type | Derived in the durable reasoning ledger from its Conversation Event |

Completed work and progress updates are retained in the ledger for explanation but must not be
rewritten as new future work.

### Verification and completeness

Both existing passes remain. They now verify responsibility recall, grounding, actors, ownership,
dates, state, and deduplication. A deterministic adapter removes any premature commitment a model
might leak before synthesis.

### Outcome clustering and promotion

Global synthesis sees the verified responsibility set and the full linked Conversation Event set.
It clusters related work without erasing independent actions. A cluster may become a commitment
only when it is an explicit accepted future outcome, broader than one action, useful to track, and
supported by multiple responsibilities or explicit milestone language.

There is no target commitment count. Meeting evidence and the promotion test determine the count.
Names stay close to participants' language.

### Hierarchy and judge

The hierarchy builder links responsibilities only to promoted outcomes they naturally support.
Accepted requests, assignments, and promises remain standalone when no promoted outcome requires
them.

A separate model call then judges each proposed commitment. After that call, a deterministic guard
requires accepted ownership plus breadth, and demotes straightforward action verbs. Demotion
preserves source segments, Conversation Event IDs, owners, and lineage.

### Explanation ledger

The durable checkpoint stores `state.reasoningTrace`. The development extraction endpoint exposes
it as `pipeline.execution_intelligence_v2.reasoning_trace`. Each responsibility records its type,
state, signal, evidence, final disposition, target ref, and a reason. Each proposed commitment also
records whether the guard kept or demoted it and why.

Disposition meanings:

- `commitment`: a promoted, accepted outcome (represented by the cluster in `proposed_clusters`)
- `child_task`: a responsibility naturally required by a promoted outcome
- `standalone_task`: accepted work with no natural promoted parent
- `decision`: a decision without separately accepted future work
- `idea`: optional or future scope
- `progress_update`: present/past status, not new work
- `completed_work`: work already done
- `proposal`: suggested but unaccepted work
- `question`: inquiry without responsibility
- `cancelled`: rejected or cancelled action

## Migrated files

- `lib/execution-intelligence/execution-v2.ts`: responsibility adapter, ledger, promotion guard,
  provenance-preserving demotion, and final explanations.
- `lib/execution-intelligence/prompts.ts`: responsibility-first extraction, verification,
  completeness, clustering/promotion/hierarchy, and judge policies.
- `lib/execution-intelligence/model.ts`: adds the independently observable `judge` model stage.
- `lib/execution-intelligence/stages.ts`: supplies full events to synthesis and runs the judge.
- `lib/execution-intelligence/durable-pipeline.ts`: enforces V2 boundaries and checkpoints traces.
- `lib/execution-intelligence/pipeline.ts`: keeps the synchronous/test pipeline behavior aligned.
- `lib/execution-intelligence/consolidation.ts`: expands verb demotion and preserves event IDs.
- `app/api/dev/meeting-extraction-debug/route.ts`: exposes the latest V2 reasoning trace in dev.
- `tests/execution-intelligence-v2.test.ts`: regression coverage for responsibility-only input,
  promotion, verb demotion, provenance, and explanations.

## Debugging a meeting

In development, request:

```text
/api/dev/meeting-extraction-debug?meetingId=<meeting UUID>
```

Inspect `reasoning_trace.responsibilities` first, then `proposed_clusters`, then
`judged_commitments`. This distinguishes extraction/classification failures from bad clustering,
promotion, hierarchy, or final-judge decisions without guessing from persisted rows alone.
