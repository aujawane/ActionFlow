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
- Set commitment_ref=null, supporting relationship fields empty/null (including relationship_decision=null),
  and use the supplied topic ID.
- execution_classification is committed only for open accepted work; proposals use proposed, ideas
  use future_consideration, and other non-execution records use requirement.
- Explain the action classification in extraction_reason. Return only schema-valid JSON.
`.trim();

export const INDEPENDENT_COMMITMENT_EXTRACTION_PROMPT = `
You reason about accepted future outcomes for one complete meeting. Return tasks=[] and only
commitments supported by accepted evidence.

A task is a concrete action. A commitment is a broader accepted future outcome that one or more
concrete actions serve. Never repeat an existing action as a commitment unless its wording states a
genuinely broader outcome than the action itself.

Reason in this order:
1. Review extracted_actions, the grounded accepted-work inventory for this meeting.
2. Identify groups of actions that serve the same purpose.
3. For each group (or single action), ask: "What broader future outcome are these actions intended
   to accomplish?"
4. Create a commitment only when all of the following hold:
   - the outcome is supported by the transcript;
   - accountability for the outcome was explicitly accepted, not merely discussed;
   - the outcome is broader than the concrete action(s) that support it;
   - the outcome is useful to track independently of any single action.
5. Separately, scan the transcript for explicit accepted future outcomes that have no supporting
   action yet — an outcome someone accepted responsibility for before any concrete step was
   discussed. Extract these directly with supporting_action_refs=[]. Do not require the action
   inventory to already contain every task that will eventually support the outcome: an explicit
   accepted outcome ("we should have a version before next Tuesday") is a commitment on its own,
   even if the actions that will get there were not enumerated in this meeting.

Before emitting any commitment, answer these four questions against the evidence:
- Which action refs, if any, support this commitment?
- What broader scope does this commitment add beyond those actions — write it in
  scope_added_beyond_actions?
- Would completing the linked actions reasonably complete or materially advance this outcome?
- Would a meeting participant recognize this as the outcome they agreed to achieve, not just a
  restatement of one thing they said they'd do?

If the commitment title (or its evidence) is merely a paraphrase of one supporting action — same
quote, same scope, nothing broader — do not emit it as a commitment; that action stays a task only.
A commitment is never required to have multiple supporting actions: a single action can be the
commitment when the action's own wording already states the broader outcome (for example "Deploy
Parfait before next Tuesday"). What disqualifies a commitment is redundancy with an action, not a
low action count.

A commitment is a concrete, trackable future outcome that a person or group accepted accountability
for delivering. Never create a commitment from a topic, theme, discussion, summary, unaccepted
request, proposal, idea, progress update, completed work, deferred/future-scope work, or a decision
without a future outcome — even when participants spent significant time on it. A plan explicitly
deferred to later ("we'll automate that eventually") is not a current commitment. A status update on
work already in progress elsewhere ("the Mac Mini is still on backorder") is not a new commitment.

Examples:
- Actions: create Chatter session, test transcript input, observe behavior, message the group.
  Correct commitment: "Validate Chatter using real Parfait meeting context."
  Incorrect: emitting "Create Chatter session," "Test transcript input," or "Message the group" as
  their own commitments — each is redundant with its action.
- Actions: contact sales, research enterprise billing, follow up with Kathy.
  Correct commitment: "Establish or clarify enterprise OpenAI/Codex access."
  Incorrect: emitting "Contact sales," "Research enterprise account usage," or "Follow up with
  Kathy" as their own commitments.
- Transcript: "We will deliver the client migration by September 1," with no implementation actions
  discussed. Correct: a commitment with supporting_action_refs=[] (the zero-task case) — do not
  withhold it merely because the action inventory has nothing to point to yet.

Keep titles close to meeting language. Ground owner, status, date, exact quote, and segment UUIDs in
the transcript evidence for the commitment itself. In commitment_reason, name the accepted actions
(if any) that motivated the commitment and explain why the evidence shows accepted accountability
rather than discussion. In scope_added_beyond_actions, state the broader outcome in your own words;
for the rare single-action commitment, explain what makes that action's own wording already an
outcome rather than a step. All returned commitments use execution_classification=committed. Return
only schema-valid JSON.
`.trim();

export const TASK_COMMITMENT_RELATIONSHIP_PROMPT = `
You evaluate relationships between independently extracted open tasks and commitments by purpose,
not topic similarity. Return every supplied commitment and task exactly once with stable refs and
unchanged core fields.

For every task, weigh it against every plausible commitment and ask: "Is this action being performed
in order to accomplish this commitment?" — not "do these two items mention the same subject."

Decide one of:
- child_task: the task is being done in order to accomplish the commitment; completing it reasonably
  advances or completes that outcome.
- standalone_task: the task serves no supplied commitment, or serves its own separate purpose.
- uncertain: the evidence does not clearly show purpose either way.

Rules:
- Link (child_task) only when completing the task materially advances the broader outcome the
  commitment represents.
- Never link merely because a task and a commitment share a topic, owner, or similar wording.
- Do not leave a task standalone when its transcript context clearly states it is part of the same
  experiment or outcome the commitment represents, even if the task's title alone looks generic.
- Treat uncertain the same as standalone for the resulting relationship: when purpose is not clearly
  shown, prefer no link over a speculative one.
- A task may have at most one primary commitment_ref. A commitment may have zero linked tasks.
- Completed work, in-progress reports, requests without acceptance, ideas, proposals, decisions, and
  questions must remain unlinked regardless of topic.

For each task, set: commitment_ref (the linked commitment's ref, or null for standalone_task and
uncertain), relationship_decision (child_task, standalone_task, or uncertain),
relationship_confidence, relationship_reason explaining the purpose judgment (this is the standalone
reason when commitment_ref is null), and supporting segment IDs in relationship_evidence.

Examples:
- "Create Chatter session from last week's transcript" -> child_task of "Validate Chatter using real
  Parfait meeting context": the session is how validation gets performed.
- "Give Chatter feedback" -> child_task of the same commitment: feedback is part of the validation
  loop, even though its title does not mention Chatter validation directly.
- "Follow up with Kathy" -> child_task of "Establish or clarify enterprise OpenAI/Codex access":
  the follow-up exists to unblock enterprise access.
- "Continue Cursor support correspondence" -> standalone_task: no supplied commitment's outcome
  depends on this thread.

Do not add or remove items. Return only schema-valid JSON.
`.trim();

export const INDEPENDENT_GRAPH_VERIFICATION_PROMPT = `
Verify the supplied independent commitment/task graph against transcript evidence. Verify; do not
rebuild a hierarchy and do not invent replacement items. Preserve stable refs.

For each commitment, verify:
- it states a broader outcome, not a single concrete action restated;
- accountability for it was explicitly accepted, not merely discussed or proposed;
- it is grounded in real source evidence (owner, quote, segment IDs);
- scope_added_beyond_actions describes real added scope beyond its supporting_action_refs, not a
  repeat of one action's wording;
- owners are the people who actually accepted the outcome;
- a zero-task commitment is valid only when the transcript shows an explicit accepted outcome, not
  an idea or proposal.
If a proposed commitment is clearly just one accepted action restated, do not keep it as a
commitment; it may be returned as a standalone task using the same evidence instead.

For each task, verify:
- it is an actual accepted/open action, not a proposal, idea, decision, question, or unaccepted
  request;
- its owner is correct;
- its child/standalone relationship is correct — unlink any relationship that does not materially
  advance its commitment, but do not strand a task as standalone when the transcript clearly places
  it inside the same experiment or outcome as a supplied commitment;
- completed or already-in-progress work is not reopened as new pending work;
- work explicitly deferred to later, or a status update on something already in progress elsewhere
  (for example an order already placed), is not treated as active pending work.

Specifically reject:
- a task duplicated as its own zero-child commitment with the same evidence;
- deferred or future-scope work represented as a current commitment;
- a status update (order/backorder/progress report) represented as a new commitment;
- completed work represented as pending execution.

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
