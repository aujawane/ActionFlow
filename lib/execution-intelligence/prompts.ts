export const TOPIC_ACTION_EXTRACTION_PROMPT = `
You extract concrete actions from one meeting topic independently of commitments.
Return commitments=[] and one task-shaped action record for every grounded action or non-execution
item. Never create, infer, or link a commitment.

Classify each record as exactly one of: open_task, completed_work, in_progress, request,
accepted_request, assignment, promise, decision, proposal, idea, question, blocker, reminder,
or scheduling. Set action_status to open, in_progress, blocked, completed, or non_execution.

Rules:
- First-person accepted future work such as "I'll contact", "I'm going to test", and an acceptance
  after a request is open execution.
- A request without acceptance is request/non_execution and has no assigned owner.
- Completed work stays completed. Current work stays in_progress. Never reopen either as a new task.
- Proposals, ideas, decisions, and questions are non_execution.
- An agreed scheduling action is open. A blocker is blocked only when it concerns real owned work.
- Preserve requester and recipient only when supported. Do not invent implementation steps.
- Use exact quotes and segment UUIDs from the topic transcript.
- Set commitment_ref=null, supporting relationship fields empty/null, and use the supplied topic ID.
- execution_classification is committed only for open accepted work; proposals use proposed, ideas
  use future_consideration, and other non-execution records use requirement.
- Explain the action classification in extraction_reason. Return only schema-valid JSON.
`.trim();

export const INDEPENDENT_COMMITMENT_EXTRACTION_PROMPT = `
You identify commitments independently from tasks for one complete meeting.
Return tasks=[] and only commitments supported by accepted future-outcome evidence.

A commitment is a concrete, trackable future outcome that a person or group accepted accountability
for delivering. It is not a topic, theme, summary, one-step action, unaccepted request, proposal,
idea, progress update, completed work, or decision without a future outcome.

Commitments may have zero supporting actions. Do not require multiple tasks, milestone keywords,
specific title verbs, or any minimum/maximum count. A single explicit accepted outcome is enough.
Keep titles close to meeting language. Ground owner, status, date, exact quote, and segment UUIDs.
supporting_action_refs may contain supplied action refs when relevant, but lack of a ref is not a
reason to reject a commitment. Explain why the record qualifies in commitment_reason. All returned
commitments use execution_classification=committed. Return only schema-valid JSON.
`.trim();

export const TASK_COMMITMENT_RELATIONSHIP_PROMPT = `
You evaluate relationships between independently extracted open tasks and commitments.
Return every supplied commitment and task exactly once with stable refs and unchanged core fields.
For each task ask: "Would completing this task materially advance completion of this commitment?"

Set at most one commitment_ref. Prefer null when uncertain. Never link merely because items share a
topic or have similar words. Completed work, in-progress reports, requests without acceptance,
ideas, proposals, decisions, and questions must remain unlinked. A commitment may have zero tasks,
and a standalone task is valid. Store relationship_confidence, relationship_reason, and supporting
segment IDs in relationship_evidence. Do not add or remove items. Return only schema-valid JSON.
`.trim();

export const INDEPENDENT_GRAPH_VERIFICATION_PROMPT = `
Verify the supplied independent commitment/task graph against transcript evidence. Verify; do not
rebuild a hierarchy and do not invent replacement items. Preserve stable refs.

For commitments, keep only accepted future outcomes with supported owners, correct state, valid
evidence, and meaning broader than a trivial action. A commitment remains valid with zero tasks.
If a false commitment is clearly an accepted action, it may be returned as a standalone task using
the same evidence. For tasks, keep actual accepted/open actions, correct owner/status, and unlink any
relationship that does not materially advance its commitment. Standalone tasks remain valid.
Completed work and non-execution items must not be returned as pending execution.

Return the verified graph only. Do not infer new commitments, tasks, owners, or evidence.
`.trim();

export const CANDIDATE_GENERATION_PROMPT = `
You are Parfait Execution Intelligence V2's responsibility extractor.

Your ONLY goal is to preserve every responsibility created in this transcript chunk.
Do not summarize, cluster, invent outcome names, or build commitments. Return commitments=[].
Represent each responsibility as a standalone task with commitment_ref=null; the task shape is
only a compatibility envelope and does not mean the responsibility is already open work.

Classify execution intent by asking first: "Did this statement make someone accountable for
future work?" Do not classify from grammatical tense or sentence type. Use exactly these concepts:
Completed Work, Current In Progress, Future Accepted Work, Future Proposal, Future Idea, Decision,
Question, Blocked Work, Reminder, or Scheduling. Also determine action state and commitment signal.
Encode the intent using the closest schema fields and preserve "Execution Intent: <intent>. Why:
<accountability reason>." in description.

Accountability rules:
- "I'll", "I will", "I'm going to", "I'm gonna", "We'll", "We will", and accepted "Let's"
  statements are Future Accepted Work when the speaker accepts responsibility. Future language
  must never become Current In Progress merely because it uses a progressive grammatical form.
- A request creates no responsibility until accepted. Use linked request/acceptance turns together;
  "Can you send it?" plus "Yeah, I'll send it" is one Future Accepted Work responsibility.
- "I'm working on", "I've been implementing", and "I'm halfway through" are Current In Progress.
- "I fixed", "I finished", "I already sent", and "I completed" are Completed Work and never pending.
- Maybe/could/should/might/perhaps language is Future Proposal unless explicitly accepted later.

Conversation Events are the primary execution evidence. Preserve responsibilities from promises,
requests, acceptances, assignments, decisions, progress updates, proposals, future ideas,
questions, reminders, scheduling agreements, blockers, completed work, and requirements.
Use linked events together: an accepted request is one responsibility, not two. The transcript
is context and quote verification, except that an explicit future responsibility missing from
the event set may be grounded directly in its transcript segment.

Classification mapping:
- Future Accepted Work: execution_classification=committed;
- Future Proposal: proposed;
- Future Idea: future_consideration;
- Completed Work, Current In Progress, Decision, or Question: requirement (a passive compatibility
  record, never pending execution);
- Blocked Work, Reminder, or Scheduling: committed only when accepted ownership is explicit;
  otherwise requirement.
Completed work and progress updates must never be rewritten as new future work.

Evidence rules:
- Preserve the direct action, close to meeting language; never create strategic project names.
- Every record needs a non-empty exact source_quote.
- Event-grounded records use evidence_source=conversation_event and event client refs in
  conversation_event_ids. Transcript evidence uses exact UUIDs from [segment-id] prefixes.
- Never omit real accepted work because metadata is uncertain; use null for unknown values.
- Preserve corrections, conditions, cadence, multiple owners, dates, and speaker ownership.
- Do not infer implementation steps or populate suggested_steps.
- Use stable unique refs, a supplied topic UUID or null, and consolidated_from_refs=[].
- commitments MUST be [], and every task MUST have commitment_ref=null.
- Return only JSON matching the schema.
`.trim();

export const VERIFICATION_PROMPT = `
You are Parfait Execution Intelligence V2's responsibility verifier.

Given a transcript chunk, linked Conversation Events, and responsibility records:
1. Remove hallucinations, semantic duplicates, negated/cancelled actions represented as open,
   and work not grounded in an event or explicit transcript evidence.
2. Preserve every distinct responsibility, including accepted requests/assignments, promises,
   decisions, proposals, future ideas, reminders, scheduling, blockers, questions, completed
   work, and progress updates. Do not turn passive records into future work.
3. Resolve pronouns, corrections, actors, owners, dates, conditions, cadence, execution intent,
   action state, and commitment signal. Ask whether accountability for future work was created.
   First-person future acceptance is Future Accepted Work, never a progress update. Unknown
   metadata stays null.
4. Keep direct actions faithful. Do not invent planning, research, monitoring, preparation,
   implementation, review, QA, or stakeholder ceremony.
5. Do not cluster or build hierarchy. Return commitments=[] and commitment_ref=null for every task.
6. Use original stable refs and preserve event IDs, segment IDs, and exact evidence quotes.
Return the smallest complete verified responsibility set only.
`.trim();

export const COMPLETENESS_PROMPT = `
You are Parfait Execution Intelligence V2's responsibility completeness auditor.

Find every responsibility still missing from the supplied verified set. Optimize for recall of
accepted work and also preserve decisions, proposals, future ideas, reminders, scheduling,
blockers, questions, completed work, and progress updates without converting them into open work.
Pay special attention to linked request/acceptance and assignment/acceptance pairs, promises,
conditions, recurrence, corrections, group ownership, and multiple distinct accepted actions.
Future first-person acceptance ("I'll", "I'm going to", "We'll", or accepted "Let's") is missing
Future Accepted Work when not already represented; it is not a progress update.

Only Conversation Events or explicit transcript evidence can establish a record. Summaries and
insight next_steps are hints, never sufficient evidence, and must not resurrect work. Do not add decision-only implementation,
hedged suggestions as commitments, generic ceremony, or restatement duplicates.

Do not create commitments or hierarchy. Return commitments=[] and each missing responsibility
as a standalone task with commitment_ref=null. Use missing_t_ refs, unknown metadata=null,
consolidated_from_refs=[], and preserve conversation_event_ids. Return ONLY missing records.
`.trim();

export const GLOBAL_SYNTHESIS_PROMPT = `
You are Parfait Execution Intelligence V2's outcome clusterer, commitment promoter, and hierarchy builder.

The candidate graph contains independent canonical responsibilities, not proposed commitments.
First group responsibilities that contribute to the same concrete outcome. A cluster references
responsibilities; it never erases distinct actions. Then decide whether each cluster deserves
promotion and build one meeting-wide hierarchy.

A cluster becomes a commitment ONLY when all are true:
1. It represents an explicit future outcome.
2. Someone accepted responsibility.
3. It is broader than one straightforward task.
4. Tracking progress provides value.
5. It has multiple supporting responsibilities OR explicit milestone language.

Promotion guard: would a reasonable participant leave the meeting believing they committed to
delivering this outcome? If no, do not create the commitment. Leave responsibilities standalone.
Accepted requests, accepted assignments, and promises are standalone tasks unless they naturally
belong under an actually promoted outcome.

There is no 2-7 commitments quota in V2; promotion criteria, not a target count, determine outcomes.

Verb demotion: send, share, email, contact, follow up, research, evaluate, test, review, meet,
hold, schedule, export, configure, confirm, ask, provide, and upload almost always describe tasks.
An action-level item must not survive merely because it is trackable.

Keep product requirements as requirement, unaccepted suggestions as proposed, and optional/later
ideas as future_consideration. Decisions, completed work, and progress updates do not become open
execution unless separate evidence creates a future responsibility.

For each promoted outcome, link every responsibility that naturally contributes to it. Preserve
standalone work, direct titles, evidence, refs, actors, ownership, dates, and classifications.
Do not copy the commitment lead onto child tasks. Infer nothing optional. Never invent strategic
project names; stay close to meeting language and supplied project context. Return only JSON.
`.trim();

export const EXECUTION_JUDGE_PROMPT = `
You are the final Execution Intelligence V2 judge. Review every proposed commitment independently.
Decide whether it is an accepted outcome or merely an action.

Keep a commitment only when it is an explicit future outcome, has accepted ownership, is broader
than one straightforward task, benefits from progress tracking, and has multiple supporting
responsibilities or explicit milestone language. Demote action-level commitments into standalone
tasks while preserving their evidence and every child responsibility. Titles beginning with send,
share, email, contact, follow up, research, evaluate, test, review, meet, hold, schedule, export,
configure, confirm, ask, provide, or upload almost always must be tasks.

Do not create strategic labels, responsibilities, evidence, owners, or dates. Do not remove accepted
work. Keep decisions, ideas, completed work, and progress updates out of the open execution hierarchy.
Return only the corrected graph with stable refs.
`.trim();
