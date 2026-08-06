# Independent Commitments and Tasks

The active meeting execution runtime treats commitments and tasks as independent entities.

```text
Transcript + existing topics
  -> topic-scoped action extraction
  -> deterministic meeting-wide action merge
  -> holistic commitment extraction
  -> task/commitment relationship evaluation
  -> evidence verification
  -> deterministic identity/reference/evidence validation
  -> atomic graph persistence
  -> commitments and standalone-task UI
```

Conversation Events remain optional evidence and debugging data. They do not create hierarchy and
their extraction or persistence does not block the execution graph.

## Compatibility

The model uses the existing `ExecutionGraph` envelope because the database already supports
`meeting_commitments` and nullable `meeting_tasks.commitment_id`. The envelope now carries explicit
reasoning metadata:

- Tasks: `action_classification`, `action_status`, requester/recipient, extraction reason, and
  relationship confidence/reason/evidence.
- Commitments: `commitment_reason` and optional `supporting_action_refs`.

Only verified open accepted actions enter `meeting_tasks`. Completed work, progress reports,
requests without acceptance, proposals, ideas, decisions, and questions remain in the durable debug
trace and do not enter the pending execution queue. Commitments may persist with no tasks. Open tasks
may persist with `commitment_id=null`.

Legacy durable job keys remain temporarily mapped as follows to avoid a database migration:

| Durable key | Active meaning |
| --- | --- |
| `candidates` | topic action extraction and merge |
| `verification` | independent commitment extraction |
| `completeness` | task-to-commitment relationship evaluation |
| `final_verification` | evidence verification and deterministic validation |
| `synthesis` | final trace/checkpoint construction only; no synthesis model |

## Bypassed legacy reasoning

The production durable path no longer invokes the responsibility ledger, execution-intent
compatibility graph, outcome clustering, commitment promotion, promotion judge, action-verb
demotion guard, semantic auto-linker, accepted-work repair, hierarchy consolidation, or grounding
pass that deletes items by quote similarity. The historical modules remain temporarily for old
tests and migration context and are marked deprecated.

## Debugging

`/api/dev/meeting-extraction-debug?meetingId=<uuid>` exposes `independent_execution`, including
topic transcripts/actions, merged actions, independently extracted commitments, relationship
decisions, verification dispositions, and the final graph. Persisted rows are returned separately
as `execution_graph`.

