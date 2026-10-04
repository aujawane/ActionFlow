export const TRANSCRIPT_NORMALIZATION_PROMPT = `
You correct high-confidence transcription errors in a meeting transcript -- nothing else. You are
given a window of the transcript with segment IDs and speakers, the participant list, and a
project_vocabulary list of known project entities (people, products, tools, repositories,
platforms, domains, acronyms) with their previously-observed aliases/mishearings.

Only propose a correction when you can point to specific supporting evidence: a project_vocabulary
entry (canonical term or one of its aliases), a participant name, or a name/term used correctly
elsewhere in this same window that a misheard token clearly should have matched. A correction with
no such evidence is not high confidence, no matter how plausible it sounds -- do not propose it.

You may only fix mis-transcribed entity names: people, products, projects, tools, repositories,
platforms, domains, and acronyms. You may never:
- paraphrase, summarize, or reword anything;
- change what a speaker meant, decided, or accepted;
- change ownership, dates, modality ("will" vs "might"), or acceptance language;
- fix grammar, filler words, or ordinary transcription noise unrelated to a named entity;
- resolve an ordinary English word into a project entity just because the entity's name happens to
  sound similar (e.g. never turn a literal, ordinary use of "recall" the verb into "Recall.ai"
  unless the surrounding sentence is unmistakably about that product) -- when in doubt, this is not
  high confidence, leave it unchanged;
- expand a short, correctly-heard word or name into a longer participant/speaker identifier,
  username, handle, or slug just because that fuller string appears in the participant list or
  segment metadata (e.g. hearing "Craig" and turning it into "craiglauer" or "Craig Lauer" purely
  because that longer identifier is present in participant data) -- a participant name may help you
  confirm how a name is spelled or cased, never license extending or completing it into something
  longer than what was actually said.

A correction's original_token and replacement must each be a single entity name or a short,
coherent multi-word entity name (for example "Claude Code", "Visual Studio Code", "San Diego State
University") -- never a clause, a phrase containing a verb, or a sentence. If what actually needs
fixing is not a self-contained name, do not propose a correction for it.

Set confidence honestly for every correction -- it determines whether the correction auto-applies
downstream (only near-certain corrections should score high) or is only recorded as a suggestion
for human review. Include your supporting evidence on every correction so a low-confidence
suggestion is still legible even though it will not be auto-applied.

Do not invent entities. An unusual but consistent name used the same way throughout this window is
correct, not an error. Only return entries for segments you are actually correcting -- do not
return one for every segment.

Separately, you may notice a term that looks like project-specific vocabulary (a product, tool, or
proper noun used consistently and confidently by speakers) that is NOT in project_vocabulary and
that you are NOT confident enough to auto-correct into the transcript. When that happens, emit it
as a vocabulary_candidates entry (canonical_term = your best guess at the correct spelling,
observed_alias = the actual mis-transcribed token seen) instead of a correction -- this only
proposes the term for future human review; it never changes the transcript itself. Only propose a
candidate when the same unfamiliar term recurs or is used with clear confidence -- a single
ambiguous unknown proper noun with no supporting context should be left alone entirely, with
neither a correction nor a candidate.

Return only schema-valid JSON.
`.trim();

export const WORK_ITEM_EXTRACTION_PROMPT = `
You extract grounded work items from one meeting topic. A work item is a single, concrete,
directly-quotable fact about accepted, proposed, completed, or discussed work. You do not know
whether commitments exist and must never group, cluster, or relate items to one another -- that is
a separate, later decision made by someone else with full visibility of every item you extract.

Return one work item for every grounded item: accepted/open work, completed work, in-progress work,
requests (accepted or not), proposals, ideas, questions, blockers, reminders, scheduling agreements,
requirements/acceptance criteria, and client-provided inputs a deliverable depends on. Do not skip
non-execution items -- they are needed for audit even though only eligible accepted current-scope
work will ever become part of the execution tree.

Classify each item as exactly one of: open_task, accepted_request, assignment, promise, reminder,
scheduling, completed_work, in_progress, request, decision, proposal, idea, question, blocker.
Set status to open, in_progress, blocked, completed, or non_execution.

Set three further, independent fields:
- acceptance_state: "accepted" when someone took ownership of a future action; "requested" when
  asked but not yet accepted; "proposed" when floated but not accepted; "none" when acceptance does
  not apply (completed work, a question, a bare decision with no follow-up owner).
- execution_scope: "project_work" when it actually advances the project; "personal_logistics" for
  someone's own availability/schedule with no project deliverable attached; "informational" for a
  status update or fact with no future action attached.
- scope_state (your best first guess -- a later meeting-wide pass has final say): "current_scope"
  when the meeting establishes this is being worked now; "future_scope" when explicitly deferred
  ("later", "phase two", "once the first version ships", "not yet"); "optional" when conditional on
  something uncertain; "superseded" only when you can see the overriding statement in this same
  topic's transcript; "informational" for status/fact content with no scope of its own.
- work_item_role: "action" (a concrete step someone does), "input_dependency" (something another
  person must provide before an action can complete, e.g. content, assets, answers, credentials),
  "acceptance_criterion" (a requirement or quality bar the deliverable must satisfy -- not a step
  anyone takes, a condition of "done"), "scope_decision" (a decision about what's in/out of scope),
  "future_feature" (a capability explicitly placed later), "reference" (an example, prior site,
  inspiration mentioned for context), "idea" (an unaccepted suggestion), "question" (an open
  question), "status_update" (a fact about something already in motion), or
  "incidental_troubleshooting" (minor technical fumbling with no lasting follow-up).

A statement can be grammatically "I'll ..." and still be personal_logistics ("I'll come back on the
17th") or informational in spirit if it carries no project deliverable -- judge execution_scope and
work_item_role by what the statement actually produces, not by its grammar.

VOLUNTARY PROMISE PRINCIPLE: a speaker voluntarily stating that they (or a clearly identified group
they speak for) will perform a concrete future action is itself a promise -- accepted, open,
project_work, role=action -- regardless of whether anyone else requested it first. "I'll send you
that article" is an active promise even if nobody asked for it; do not withhold acceptance just
because no prior request exists in the transcript. This is a semantic pattern to recognize in
whatever words a speaker actually uses ("I'll ...", "I will ...", "I'm going to ...", "I can
definitely ...", "we are going to ...", and equivalents) -- not a fixed phrase list, and it never
overrides the surrounding-context checks below (personal logistics, informational content, a
hypothetical/illustrative example, or a genuinely conditional "maybe"/"could" still take precedence
when the context actually is one of those).

CURRENT_SCOPE VS FUTURE_SCOPE: these are NOT "past vs future" or "will happen after the meeting vs
during it" -- almost everything worth extracting will execute after the meeting ends. The distinction
is whether the work is presently agreed to:
- current_scope: the work is accepted, active, assigned, or committed as a direct result of THIS
  conversation, even though it will necessarily be carried out later ("I'll send you the article
  tomorrow", "I'll finish this and confirm the drops work", "we're going to test this build and send
  feedback" are all current_scope -- the timing is future, the commitment is now).
- future_scope: the work is speculative, backlog, deferred, next-version, or not yet activated
  ("maybe we should add voice support eventually", "we could do that in the next version", "that's
  something we might build later" -- future_scope unless the conversation clearly turns it into
  accepted current work with an owner and a concrete outcome).
A future-tense verb is not itself evidence of future_scope, and an immediate timeframe is not itself
evidence of current_scope -- judge only whether the transcript shows the work as presently agreed.

A hypothetical, illustrative, or example scenario used to explain a concept or workflow (e.g. "let's
say a user had to do X", "for example, if someone needed Y") describes a fictional situation, not
real accepted work for a real participant -- role=idea or reference, execution_scope=informational,
acceptance_state=none, no matter how concrete or task-like the illustrative action sounds.

Rules:
- First-person accepted future work such as "I'll contact", "I'm going to test", and an acceptance
  after a request is accepted, open, project_work, role=action -- even when the sentence also reads
  like it is recording a decision. Do not classify an "I'll ..." acceptance as a bare decision
  merely because it resolves a discussion. See VOLUNTARY PROMISE PRINCIPLE above -- this applies
  identically whether or not a prior request exists.
- When the transcript explicitly names more than one person jointly performing the work ("Sam and
  I are going to test this with Priya"), list every named participant in owners -- do not collapse a
  clearly multi-person commitment down to a single name or drop the others because one person is
  speaking.
- A request without acceptance is request/non_execution, acceptance_state=requested.
- Completed work stays completed_work/completed, acceptance_state=none. Current work stays
  in_progress/in_progress.
- A requirement someone states the deliverable must satisfy ("it needs to explain X", "make sure it
  has Y") is role=acceptance_criterion, not an action, even when phrased as an instruction.
- Something one person must send/provide before another can finish their action ("send me the
  images", "I'll get you the FAQ answers") is role=input_dependency when accepted.
- An agreed scheduling action for the project is open/project_work/role=scheduling-as-action.
  Personal availability framed as scheduling is scheduling classification with
  execution_scope=personal_logistics.
- A blocker is blocked only when it concerns real owned project work.
- Strategic or exploratory discussion -- a pattern or technique worth trying, a skill someone wants
  to develop, "I've been looking into X" (in-progress context, not a future deliverable), "I want to
  learn/explore X" (personal development, not a task), a technical example used to illustrate a
  point, a description of how a possible workflow could work, or encouragement ("you should focus on
  X", "that's worth exploring") -- is role=idea or status_update with execution_scope=informational
  (or scope_state=optional when genuinely conditional), never role=action, no matter how technical or
  work-adjacent the topic is. It becomes role=action/accepted project work only when a participant
  explicitly accepts a concrete future outcome or experiment, with an owner and a recognizable
  completion condition -- not merely because the discussion was detailed or enthusiastic.
- Preserve requester and recipient only when supported by the transcript.
- Do not invent implementation steps beyond what was actually said.
- Use exact quotes and segment UUIDs from the topic transcript.
- In extraction_reason, explain why this item was extracted and its classification/status. In
  classification_reason, justify acceptance_state, execution_scope, scope_state, and
  work_item_role together -- this is the field most likely to be checked.
- You do not output a ref, a parent, or a standalone/child decision of any kind. Return only
  schema-valid JSON.
`.trim();

/**
 * PASS A of the former single "global correction" call (see docs/... V4 recall/temporal hardening
 * notes): completeness recovery ONLY. Runs once per chronological transcript window (see
 * lib/execution-intelligence/work-item-stages.ts's runCompletenessRecoveryPass) so a sparse,
 * easy-to-miss voluntary promise buried in one part of a long meeting is not competing for the
 * model's attention against five other unrelated correction responsibilities in the same call --
 * the generation-6 staging benchmark showed the combined pass could satisfy some of its
 * responsibilities while silently skipping others in the same run. This pass NEVER repairs an
 * existing item; see LIFECYCLE_RECONCILIATION_PROMPT for that.
 */
/**
 * PASS A of completeness recovery (ATOMIC ACTION HARVEST): enumerate every plausible grounded
 * action/outcome candidate in one chronological transcript window. Deliberately ledger-blind --
 * this pass is never told what the existing ledger already contains and must never try to guess or
 * self-suppress on that basis. That judgment belongs entirely to Pass B (see
 * COMPLETENESS_ADJUDICATION_PROMPT), which is what lets this pass stay maximally high-recall:
 * "is this already known" and "is this genuinely absent, active work" are two different questions,
 * and conflating them in one pass is exactly what caused a compound turn's smaller or secondary
 * outcome to be silently dropped whenever the turn's more prominent outcome happened to look
 * already-covered.
 */
export const ATOMIC_ACTION_HARVEST_PROMPT = `
You are the atomic-action-harvest pass for one chronological window of a meeting transcript. You
are given this window's transcript (with segment IDs and speakers) and the participant list. You are
NOT given the existing work-item ledger, and that is deliberate -- your only question is "what
concrete owned or potentially-owned actions/outcomes are expressed in this transcript window?", never
"has this already been captured somewhere." A later, separate pass with full ledger visibility
decides that. Do not withhold a candidate because you assume it is probably already known elsewhere.

ACTION-LEVEL ATOMICITY: work at the level of distinct, independently-checkable OUTCOMES, not at the
level of turns, speakers, or topics. A single speaker turn, sentence, or topic can contain zero, one,
or multiple outcomes -- examine every clause. "I'll finish the implementation, verify the deployment
works, and send you the link" may contain three distinct outcomes (finish implementation; verify
deployment; send the link) -- harvest each one separately, each with its own precise quote for that
specific clause, not the whole turn's quote reused three times. A long turn about one broader
initiative can still contain one short, separate, concrete commitment buried inside it (e.g. a
housekeeping remark followed by "...and I'll also send you that document we discussed" has a
document-sending outcome distinct from the housekeeping remark) -- a small promise embedded in a much
longer explanation is exactly as real and exactly as required to harvest as one that is the entire
turn. This is not a mechanical instruction to split every "and" into separate candidates -- most
"and"s join two descriptions of the very same outcome ("I'll fix the deployment and make sure that
deployment issue is fixed" is ONE outcome said twice), not two different ones. Harvest multiple
candidates from one turn only when they are genuinely separate, independently-verifiable results
(each could be true or false, complete or incomplete, independently of the other); never split one
outcome into artificial pieces just because it was described in more than one clause.

IMPORTANT: a self-initiated promise never requires an earlier matching request in this window --
"I'll send you the article" is itself a complete, harvestable candidate on its own, whether it is the
entire turn or one brief clause within a much longer one that is mostly explanation or discussion.

VERIFICATION AND OBSERVATION ARE THEIR OWN OUTCOME: a clause that checks, confirms, verifies, tests,
or observes the result of something is a DIFFERENT, independently-checkable outcome from the work it
checks -- even when both are said in the same breath by the same speaker, and even when the
verification clause is short, hedged, or trails a longer lead-in or explanation. "I'll finish the
implementation and confirm the integration works" is TWO outcomes (finish the implementation; confirm
the integration works), not one, because the implementation can be finished while the confirmation has
not yet happened, or vice versa -- they can be independently true or false. Do not confuse this with
the "said twice" pattern above: "I'll fix the deployment and make sure that deployment issue is fixed"
restates the SAME single completion event with different words (fixing IS making sure the issue is
fixed, not a separate check performed afterward); "finish the implementation" and "confirm the
integration works" name two DIFFERENT events (building something vs. checking it). When in doubt, ask:
could one of these be true while the other is still false? If yes, harvest both separately, each with
its own precise clause as its quote -- never let a verification/confirmation clause go unharvested
merely because it shares a sentence, a topic, or a project with a more prominent nearby commitment.

COMMITTED EXPERIMENTS ARE ACTIVE WORK, NOT ASPIRATION: an explicit first-person willingness or
acceptance ("I can", "I will", "I'll", "yeah, I can definitely...") followed by a concrete
experiment, trial, or test is a committed, harvestable action the moment it is said, even though its
RESULT is not yet known -- "I can try that with my agent and see how it works," "I'll test the
workflow and see what happens," "I'll run it once just to confirm the import works" are all active
work, not speculation. Uncertainty about the OUTCOME of an experiment ("see how it works", "see what
happens", "see whether that fixes it") is not the same as uncertainty about whether the experiment
itself is committed -- harvest the experiment/verification action regardless of how the sentence
hedges about what it might find. Contrast this with genuine non-commitment, which has no accepting
first-person willingness at all: "maybe we could test that sometime" (speculation -- no one has said
they will do it), "I'd love to see how that works" (aspiration -- a wish, not a commitment), "I wonder
if that would work" (musing, not action), "we tested that yesterday and it worked" (retrospective --
already done, nothing open), "if I have time I'll test it" with no later activation shown in this
window (an unactivated conditional). Do NOT harvest these -- but DO harvest an explicit "I can/I
will/I'll [try/test/verify/check/confirm/run/experiment]... and see/find out/observe..." as real,
currently-committed work.

Harvest candidates including, illustrative, not exhaustive: voluntary promises, accepted requests,
assignments, explicit future actions with a clear (or plausible) owner, continuing work a speaker
says they will finish, verification/follow-up actions, scheduled actions, multi-person commitments
(preserve every named participant in owners -- never collapse two or more named people into a single
"Team"), and concrete conditional actions ("if you need it, I can send you X") even if you cannot
tell from this window alone whether the condition was later activated -- harvest it and let Pass B
resolve activation using full-meeting context. Include small actions; do not use importance,
strategic value, or topic prominence as a harvest filter -- a two-word promise is exactly as
harvestable as an elaborate one.

Do NOT harvest what is CLEARLY: pure informational statements or facts with no future action
attached, generic discussion or brainstorming with no owned action, unowned ideas, retrospective
statements about work already completed in the past tense, pure aspiration ("I'd love to try that")
with no commitment, speculation or hypotheticals ("maybe I could send that someday", "it would be
cool to walk them through this"), or purely social chatter. When an utterance is genuinely
ambiguous rather than clearly one of these, prefer harvesting it over omitting it -- Pass B, with
full-meeting context and ledger visibility, makes the final call; your error mode should be
over-harvesting a borderline case, never under-harvesting one.

Every candidate must be grounded in its own exact quote and real segment IDs from THIS window --
never invent one without that evidence, and never cite a segment ID that does not appear in this
window's transcript. When two distinct outcomes share the same segment (a compound turn), quote each
candidate's own exact clause, not the whole turn -- this keeps each candidate's evidence specific to
the outcome it actually represents, even though multiple candidates may cite the same segment ID.
Assign each candidate its own candidate_id, unique within this response only (e.g. "c1", "c2", ...).
State harvest_reason precisely: what in the transcript makes this a concrete, owned (or
plausibly-owned) action/outcome. If nothing harvestable appears in this window, return an empty
candidates array. Return only schema-valid JSON.
`.trim();

/**
 * PASS B of completeness recovery (MISSING-WORK ADJUDICATION): given the candidates Pass A already
 * harvested (never re-derived from the transcript by this pass), the full meeting transcript, and
 * the existing ledger, decide per candidate whether it represents genuine, currently-absent
 * execution work -- and if so, emit its final WorkItem-shaped fields. This is the ONLY place a
 * completeness addition's classification/acceptance_state/scope_state/execution_scope/work_item_role
 * are decided; Pass A never assigns them. Exhaustive coverage (one decision per given candidate) is
 * programmatically enforced afterward, never trusted on prompt wording alone.
 */
export const COMPLETENESS_ADJUDICATION_PROMPT = `
You are the missing-work adjudication pass. You are given the full meeting transcript in
chronological order (with segment IDs and speakers), the participant list, a compact summary of the
existing work-item ledger, and a specific batch of already-harvested action candidates to adjudicate
-- each with its own owner, outcome description, exact quote, and source segment IDs. You did not
harvest these candidates and must not harvest new ones or rediscover actions from the transcript on
your own -- your only job is to decide, for each candidate you were given, whether it belongs in the
missing-work ledger, using the full transcript and existing ledger for context you did not have
during harvest.

EXHAUSTIVE COVERAGE: you MUST return exactly one decision for every candidate_id you were given --
never fewer, never more, never a candidate_id you were not given. Omitting a candidate from your
response is never acceptable, including when you are confident it does not belong in the ledger --
that confidence is itself a decision (a non-"add" disposition with a reason), not an omission.

For every candidate, determine a disposition:
- "add": genuine, currently-activated/accepted execution work, absent from the existing ledger.
  Emit the full addition fields (see below).
- "already_represented": the existing ledger already contains this same real-world outcome (not
  merely the same topic or the same speaker) -- state which existing item in your reason.
- "speculative_or_inactive": hypothetical, aspirational, merely proposed/floated with no acceptance,
  or a conditional offer whose condition is never shown being invoked or accepted anywhere in the
  full transcript.
- "retrospective_or_completed": describes work already done, stated in the past tense, with no
  remaining open action.
- "non_execution": genuinely not project execution work (pure information, personal logistics with
  no project deliverable, a question, generic discussion).
- "insufficient_grounding": the candidate's own quote/segments do not actually support a concrete
  owned action once you look at them in full transcript context (e.g. the quote was taken out of
  context and does not really say what the harvested outcome claims).

VOLUNTARY PROMISE PRINCIPLE: a self-initiated promise never requires an earlier matching request --
"I'll send you the article", "I will walk them through the process", "I'll confirm the drops flow
works" are all currently-activated accepted work the moment they are said, with or without a
preceding request, and this holds however small the promise or however long the surrounding turn.

CURRENT_SCOPE VS FUTURE_SCOPE: these are NOT "past vs future" or "will happen after the meeting vs
during it" -- almost everything worth adding executes after the meeting ends. current_scope means
accepted, active, or committed as a direct result of the conversation, even though execution
necessarily happens later ("I'll send you the article tomorrow", "I'll finish this and confirm it
works", "we're going to test this build and send feedback"). future_scope means speculative, backlog,
deferred, next-version, or not yet activated ("maybe we should add voice support eventually", "we
could do that in the next version" with no clear commitment). A future-tense verb is never itself
evidence of future_scope, and an immediate timeframe is never itself evidence of current_scope.

CONDITIONAL ACTIVATION: "if you need it, I can send you X" or "if that breaks, I can take a look" is
speculative_or_inactive unless the full transcript shows the condition actually being invoked or
accepted later ("yes, please" or equivalent) -- only then does it become "add", citing both the
offer's own segment and the activating segment as source_segment_ids.

SAME REAL-WORLD OUTCOME, NOT SAME TOPIC/OWNER/SEGMENT: two candidates (or a candidate and an existing
ledger item) sharing an owner, a topic, a project, or even the exact same transcript segment are NOT
automatically the same outcome -- "verify the deployment works" is distinct from "finish the
implementation" even when one sentence states both; "confirm the tests pass" is distinct from
"schedule the release" even when the same turn states both. Mark "already_represented" only when the
existing ledger genuinely describes the same real-world result, not merely an adjacent one.

For "add", emit the addition with the same fields ordinary completeness additions always carry:
title, description, owner, owners (preserve every named participant, never collapse to "Team"),
requester, recipient, due_date, due_date_text, status, classification, acceptance_state,
execution_scope, scope_state, work_item_role, classification_reason, source_quote,
source_segment_ids, extraction_reason, confidence. Reuse the candidate's own source_quote and
source_segment_ids as the addition's evidence (refine only if the candidate's own quote was
imprecise) -- never invent evidence beyond what the candidate already cited plus, for activated
conditionals, the activating segment. For every non-"add" disposition, addition must be null.

State reason precisely for every decision. Return only schema-valid JSON with exactly one decision
per given candidate_id.
`.trim();

/**
 * PASS B of the former single "global correction" call: exhaustive lifecycle reconciliation. Given
 * the full transcript and a specific list of candidate refs, the model must return exactly one
 * review per ref -- coverage is programmatically enforced afterward (see
 * validateLifecycleReviewCoverage in work-item-stages.ts), never trusted on prompt wording alone.
 * This pass never adds a new item; see COMPLETENESS_RECOVERY_PROMPT for that.
 */
export const LIFECYCLE_RECONCILIATION_PROMPT = `
You are the lifecycle-reconciliation pass. You are given the full meeting transcript in
chronological order (with segment IDs and speakers, already normalized for entity names where
applicable), the participant list, meeting date, project context, and a specific list of work-item
refs to review, each with its own current fields and evidence. Topic-scoped extraction only sees
one slice of the meeting at a time: it cannot see a later statement that changes an earlier item's
scope, cannot see whether the item was actually performed later in the same meeting, and cannot see
that another ref you were given describes the exact same real-world action. Your job is to resolve
all of that now that the whole meeting is visible.

EXHAUSTIVE COVERAGE: you MUST return exactly one review for every ref you were given -- never
fewer, never more, never a ref you were not given. If nothing about an item needs to change, return
a review that echoes its current field values back unchanged (still with a classification_reason
confirming why the current state is correct). Omitting a ref from your response is never acceptable
under any circumstance, including when you are confident nothing about it needs to change.

DO NOT TRUST THE INCOMING FIELDS: a ref's current classification, acceptance_state, scope_state, and
execution_scope are topic-scoped extraction's first guess, not ground truth -- they can be exactly as
wrong as its owner attribution or its scope_state sequencing, and repairing all of them is your job,
not just the ones that look obviously mis-set. You will be shown refs whose current classification is
"proposal", whose acceptance_state is "proposed", or whose execution_scope is "personal_logistics" --
do not treat any of these as a signal that the ref is already correctly classified as non-actionable.
Judge every ref by what the transcript evidence actually shows, using the rules below, exactly as if
you were classifying it for the first time; only echo a field back unchanged when the evidence genuinely
supports it, never by default.

For every ref, determine:
1. Is this genuine project execution work (not personal logistics, not purely informational)?
2. Is it accepted, merely requested, or only proposed?
3. Is it current_scope or genuinely future_scope?
4. Was it actually performed/completed later during THIS meeting?
5. Does another ref you were given describe the same real-world action/completion event?
6. Is its owner/owners attribution supported by the transcript?

CURRENT_SCOPE VS FUTURE_SCOPE: these are NOT "past vs future" or "will happen after the meeting vs
during it" -- almost everything worth tracking executes after the meeting ends. The distinction is
whether the work is presently agreed to:
- current_scope: accepted, active, assigned, or committed as a direct result of the conversation,
  even though execution necessarily happens later ("I'll send you the article tomorrow", "I'll
  finish this and confirm the drops work", "we're going to test this build and send feedback").
- future_scope: speculative, backlog, deferred, next-version, or not yet activated work ("maybe we
  should add voice support eventually", "we could do that in the next version" without a clear
  commitment, "that's something we might build later").
A future-tense verb is never itself evidence of future_scope, and an immediate timeframe is never
itself evidence of current_scope -- correct any ref where topic-scoped extraction confused the two.

ACCEPTANCE REPAIR AND THE VOLUNTARY PROMISE PRINCIPLE: acceptance_state is exactly as repairable as
scope_state. A ref you are shown as acceptance_state=proposed or classification=proposal may in fact
be a genuine, self-committed acceptance that extraction hedged or under-classified -- repair it to
accepted when the transcript shows a speaker voluntarily stating they (or a clearly identified group
they speak for) will perform a concrete future action, exactly as you would for a request that was
accepted. This holds regardless of whether anyone else requested it first: "I'll send you that
article", "I still need a few more hours of work and then I'll send you the link", "I can definitely
try that with my agent" are all accepted, current-scope commitments the moment they are said, with or
without a preceding request. Do not leave a ref at proposed/proposal merely because it currently
carries that label -- only genuinely speculative, hedged-with-no-commitment, or purely
brainstormed content ("maybe someday", "we could explore X") stays proposed/proposal.

PERSONAL_LOGISTICS VS PROJECT_WORK REPAIR RULE: execution_scope=personal_logistics is also
repairable. A personal-tool action or an individual's own activity performed to accomplish or enable
project work is project_work, not personal_logistics, even though it is done on one person's own
device or in their own name -- "I'll restart Chrome so we can get the app working again", "I'll take
a screenshot of the interface for the review", "I can try that reversibility approach with my agent
and see how it works" are all project_work: the tool or actor is personal, but the purpose is the
project. Reserve personal_logistics for genuinely personal matters with no project deliverable
attached regardless of framing -- availability/scheduling ("I need to leave at 4", "I'll book my
dentist appointment"), personal errands ("I'll grab lunch"), or logistics that do not advance any
project outcome ("I need to charge my laptop"). Correct any ref where topic-scoped extraction
classified a project-serving action as personal_logistics purely because of who or what performed it.

CHRONOLOGY AND SCOPE OVERRIDE RULE: a later explicit scope or sequencing decision overrides an
earlier broad discussion. When participants discuss something broadly early on, then later
explicitly sequence what happens first versus later ("we can do X first and Y afterward", "for now
just X", "eventually Y", "phase one is X, phase two is Y", "not yet", "once X ships we'll do Y",
"parking lot", "after we validate"), the later statement must move every earlier ref it covers to
the correct scope_state -- current_scope for what's sequenced first, future_scope for what's
deferred. Do this by correcting each affected ref's scope_state (and setting
superseding_segment_ids to the later statement's segment IDs, superseded_item_refs when one ref's
acceptance is specifically superseded by another). Never move the future-scope side of the
discussion out of existence -- it must survive as a future_scope review, not disappear. Check every
ref you were given against the WHOLE rest of the transcript for this, not only the ones already
flagged as current_scope and not only when the deferral discussion happens to sit right next to the
ref's own evidence -- a deferral stated long after a ref's own evidence, or stated about a feature
named differently than the ref's own title (same underlying feature, different wording), still
controls it.

SCOPE-DEFERRAL EVIDENCE FIELDS (required precision for any current_scope -> future_scope
correction): whenever you move a ref from current_scope to future_scope because of a later
statement, you MUST populate superseding_segment_ids with the specific segment ID(s) -- occurring
STRICTLY AFTER this ref's own existing evidence -- that explicitly defer, remove, or move this SAME
feature/deliverable to a later phase, and reconciliation_reason naming exactly which later
statement controls the decision. General later discussion of a broader area, a different feature
that merely sounds similar, or a vague "maybe later" with no clear referent to THIS feature are
NEVER sufficient on their own -- the later statement must specifically address this ref's own
feature/deliverable. If you cannot point to a segment that meets this bar, do not defer the ref --
leave superseding_segment_ids empty and keep its current scope_state. This is enforced
programmatically downstream regardless of what you write here: an empty superseding_segment_ids
array, a segment ID from before this ref's own evidence, or a segment ID absent from this
transcript will cause the deferral to be rejected and the ref's scope_state kept exactly as it was.
A scope-deferral correction never changes status or classification by itself -- repair those
independently, using the rules above, only when the transcript evidence for them (not the deferral
alone) supports it.

TEMPORAL COMPLETION RULE: for every accepted or requested-then-accepted ref, look FORWARD through
the rest of the transcript, in chronological order, and ask "does the meeting go on to actually
perform this action?" This covers both an immediate same-exchange completion (a phone number read
aloud and written down, contact information stated and acknowledged, a document shared and confirmed
received, a question asked and directly answered) AND an extended completion later in the meeting (an
accepted request to "show us the demo" followed, however much later, by the meeting actually walking
through the demo; an accepted request to explain something followed by the actual explanation being
given). Either way, that ref is completed_work/completed, acceptance_state=none, not an open future
task -- the meeting itself was the delivery, no matter how long the fulfilling activity ran or how
many segments later it appears. Never leave it as accepted/open merely because a request phrase
("can you show us...", "can you share...") appears somewhere nearby -- check whether the transcript
actually goes on to show the requested thing happening, immediately or later, and mark the ref
completed whenever it does. This is strictly forward-looking: a later promise must never be marked
complete because an earlier, similar-sounding topic was merely discussed -- only genuine subsequent
performance of the SAME accepted action counts, tracked by transcript order and shared evidence,
never by topic similarity alone. Check every ref you were given for this, even ones that seem
unrelated to each other at first glance -- do not stop looking for completion evidence after finding
it for one ref.

COMPLETION EVIDENCE FIELDS (required precision for any status=completed / classification=completed_work
decision): whenever you propose that a ref was completed during this meeting, you MUST populate
completion_segment_ids with the specific segment ID(s) -- occurring STRICTLY AFTER this ref's own
existing evidence -- that show the SAME action actually being performed, and completion_reason
explaining precisely what those segments show. A later demo, a later discussion of the same
product/topic, someone describing their overall progress, or the conversation simply moving into
implementation details are NEVER sufficient completion_segment_ids on their own -- they must show the
specific promised action itself happening ("I sent it", "here, I just shared the link", "I restarted
it, let's see if that fixed it", "I took the screenshot and saved it"), not merely a related topic
being discussed. If you cannot point to segments that meet this bar, do not propose completion --
leave completion_segment_ids empty and keep the ref's prior status/classification. This is enforced
programmatically downstream regardless of what you write here: an empty completion_segment_ids array,
a segment ID from before this ref's own evidence, or a segment ID absent from this transcript will
cause the completion to be rejected and the ref kept exactly as it was. completion_segment_ids and
completion_reason are unrelated to superseding_segment_ids (which is for duplicate-representation
reconciliation, not completion) -- leave completion_segment_ids empty and completion_reason null for
every review that is not itself proposing completion.

COMMUNICATION-PROCESS RULE: a statement that establishes how future communication will happen ("if
I have questions I'll text you", "let's just email back and forth", "I'll message the group when
it's ready") is execution_scope=informational, work_item_role=status_update -- it describes a
channel/mechanism, not a deliverable. It becomes role=action only when the transcript also contains
an actual current question, message, or piece of content that someone accepted responsibility to
send through that channel. Do not manufacture a generic task like "text so-and-so with questions"
from a sentence that is only establishing that texting is now an option.

OWNER-EVIDENCE REPAIR RULE: set owner to the person the transcript directly shows accepting or
performing that specific piece of work -- the speaker of the first-person acceptance ("I'll draft
the founder story" said by Jamileh means owner=Jamileh), not whoever is coordinating around it, not
whoever will later insert/use the result, and not a co-participant merely because they are present or
discussed the topic. When a deliverable has one person producing raw content and a different person
integrating it (e.g. Jamileh drafts the founder story; Aditya builds the section and places her text
into it), these are two distinct refs with two distinct owners, not one item awarded to whoever is
more central to the overall deliverable. If two owners are both plausible from the transcript but
the evidence does not clearly resolve which one accepted, prefer leaving owner unclear (set it to
null with reconciliation_reason explaining the ambiguity) over confidently assigning the wrong
person -- a missing owner is recoverable, a wrong one is not.

FEATURE-APPROVAL VS IMPLEMENTATION-OWNERSHIP RULE: approving that a feature or requirement should
exist is not evidence that the approver will personally build it. When one speaker proposes a
product decision or feature ("let's add a retry button", "let's just do a try again button and
then you would redo the prompt") and a different speaker merely agrees or approves it ("that sounds
good", "yeah", "sure", "agreed") without separately, in their own words, committing to perform the
implementation themselves, the approving speaker is not an accountable builder-owner for it. Repair
such a ref toward classification=decision and work_item_role=acceptance_criterion (never action),
and set owner to null -- or to whoever else the transcript actually shows will build it, if anyone
-- rather than to the approver. Do not leave this as classification=accepted_request/
work_item_role=action/owner=the approver merely because an acceptance utterance exists: an
accepted_request with owner=X requires the same rigor as any other attribution under the
OWNER-EVIDENCE REPAIR RULE above -- X's own words must show X accepting to DO the work, not merely
approving that the work should happen. Contrast with a genuine self-commitment, which this rule does
NOT touch: "can you build the retry button?" / "yes, I'll build it" IS an accepted_request with that
speaker as owner -- the distinguishing question is always whether the speaker's own words commit
THEM to perform the action, not merely endorse that someone (unspecified) should. If later
transcript evidence independently shows the approver (or anyone else) will implement the feature,
attribute ownership from that evidence normally, exactly as the OWNER-EVIDENCE REPAIR RULE already
directs -- this rule only blocks inferring a builder-owner from approval alone; it is not a blanket
rule against this person ever being the owner.

DUPLICATE COMPLETION EVENT RECONCILIATION: the same real-world action often appears among your
given refs more than once -- as a request, an assignment, an accepted_request, and a promise, each
extracted independently by topic-scoped passes that could not see each other's output. These are
different conversational representations of ONE completion event, not separate pieces of work. When
two or more of your given refs' evidence (overlapping or adjacent segment IDs, the same actor, the
same concrete outcome) shows they describe the same accepted action, keep exactly ONE as the
canonical active representation and mark every other one scope_state=superseded, with
superseded_item_refs naming the canonical ref and superseding_segment_ids set to the evidence that
establishes they are the same event. If the TEMPORAL COMPLETION RULE above also applies to the
canonical ref (the action was subsequently performed), mark the canonical ref itself
completed_work/completed rather than leaving any copy open -- the result must never be that
duplicate representations independently reach eligibility, and never that a completed action
survives under one ref while an open duplicate survives under another. A ref describing the SAME
action's completion evidence (e.g. "here, I'll send you the one" immediately following "I'll take a
screenshot") is evidence for THAT action, not for an unrelated ref elsewhere in the ledger -- do not
attach one ref's completion evidence to a different, merely similar-sounding commitment.

UNSUPPORTED-SCOPE RULE: never add or imply implementation scope beyond what the transcript directly
states. A person's email address being mentioned is not evidence of any email-infrastructure work
(hosting, migration, mailbox creation, DNS/MX changes, provider setup) -- correct a ref back to
non-execution/informational if topic-scoped extraction invented such scope. Only keep or correct
scope that traces to an actual quote.

TRUE-NEGATIVE REMINDER: this pass exists to fix wrong state, not to turn more of the meeting into
work. Confirm (or correct back to) non-active state for: hypothetical or illustrative examples
describing a fictional scenario, not a real participant's real work; product demonstrations or
discussion that merely describes or references old/existing work; general opinions, brainstorming,
and feature ideas with no acceptance; "maybe"/"could"/"would be cool" phrasing with no clear owner
and no clear commitment; plain status updates about something already in motion; work already
completed in the past tense; a request nobody accepted; questions; purely informational statements;
and personal logistics with no project deliverable attached. None of these become active
current-scope work merely because they contain a future-tense verb or a technical-sounding noun
phrase.

OWNER PRESERVATION: when the transcript explicitly names more than one person jointly doing the work
("Sam and I are going to test this with Priya"), correct owners to include every one of them if
extraction dropped any -- do not collapse a clearly multi-person commitment down to whichever single
name is easiest to state, and do not invent a literal "Team" owner where the transcript actually names
individuals.

You may not create groups, clusters, or commitments of any kind, and you may not review a ref you
were not given. For every review, state classification_reason precisely (what shows acceptance vs
its absence, project relevance vs its absence) and reconciliation_reason specifically for any
scope_state/work_item_role/completion change (what later statement, if any, controls the decision;
null when nothing changed). Return only schema-valid JSON with exactly one review per given ref.
`.trim();

/**
 * Targeted completion verifier (temporal-completion precision hardening, generation-8 staging
 * benchmark follow-up). Called only for a single work item whose lifecycle review already proposed
 * completion AND already passed the programmatic evidence/chronology gate (see
 * validateCompletionEvidence in work-item-stages.ts) -- this prompt's only job is the remaining
 * semantic judgment neither of those structural checks can make: does the cited evidence actually
 * show the SAME action, not just a related topic. Deliberately narrow: no extraction, no scope
 * repair, no owner repair, no duplicate reasoning -- one question, one answer.
 */
export const COMPLETION_VERIFICATION_PROMPT = `
You are the targeted completion verifier. You are given one work item (its title, owner, and the
original evidence establishing the commitment/request/acceptance), a later piece of proposed
completion evidence (specific segment IDs and the reason another pass believes they show this item
was completed), and a small window of surrounding transcript lines for context. Nothing else about
this meeting is visible to you, and that is intentional -- you are not re-extracting work, not
repairing scope, not repairing an owner, and not reasoning about duplicates. You have exactly one
job.

Answer exactly one question: does the proposed completion evidence demonstrate that this SAME
real-world action was actually performed, after the commitment was made, during this meeting?

Same topic or entity is NOT the same action. Confirm=true only for evidence like: an explicit
statement that the specific promised thing was done ("I sent it", "here, I just shared the link",
"I restarted it, let's see if that fixed it", "I took the screenshot and saved it", "I already did
that"), or an unambiguous transcript continuation that directly shows the requested action being
carried out (the demo actually being walked through after someone accepted a request to demo
something; the specific document actually being shared after someone promised to share it).

Confirm=false for anything short of that, including: the same product or topic being discussed or
demonstrated for an unrelated reason; a status update about progress or general activity; someone
restating or repeating their intent to still do the thing; a related but different action being
performed (e.g. sharing a screen when the commitment was to send a specific file); vague reassurance
("it looks better now", "we're on it") with no explicit statement that the specific promised action
happened. When in doubt, confirm=false -- a real outstanding commitment being kept open costs a user
a moment's review; wrongly closing it out silently deletes real work with no easy way to notice.

Return schema-valid JSON: confirmed (boolean), reasoning (a precise sentence naming exactly what the
evidence does or does not show), and supporting_segment_ids (the subset of the segment IDs you were
given -- from either the original evidence or the proposed completion evidence -- that most directly
support your answer; an empty array is acceptable when confirmed is false).
`.trim();

/**
 * Targeted scope-deferral verifier (later-scope-supersession precision hardening, forensic-audit
 * follow-up). Called only for a single work item whose lifecycle review already proposed moving it
 * from current_scope to future_scope AND already passed the programmatic evidence/chronology gate
 * (see validateScopeDeferralEvidence in work-item-stages.ts) -- this prompt's only job is the
 * remaining semantic judgment neither of those structural checks can make: does the cited later
 * evidence actually defer THIS SAME feature/deliverable, not just a related or nearby one.
 * Deliberately narrow: no extraction, no completion repair, no owner repair, no grouping -- one
 * question, one answer. Mirrors COMPLETION_VERIFICATION_PROMPT's structure exactly, for the
 * opposite direction (closing scope rather than closing completion).
 */
export const SCOPE_DEFERRAL_VERIFICATION_PROMPT = `
You are the targeted scope-deferral verifier. You are given one work item (its title, owner, and
the original evidence establishing the commitment/request/acceptance), a later piece of proposed
deferral evidence (specific segment IDs and the reason another pass believes they move this item to
a later phase), and a small window of surrounding transcript lines for context. Nothing else about
this meeting is visible to you, and that is intentional -- you are not re-extracting work, not
repairing completion, not repairing an owner, and not reasoning about grouping. You have exactly one
job.

Answer exactly one question: does the proposed deferral evidence explicitly defer, remove, or move
this SAME feature/deliverable to a later phase, after the original commitment was made, during this
meeting?

Same general topic or project area is NOT the same feature. Confirm=true only for evidence like: an
explicit statement that this specific feature/deliverable is not part of the current phase ("that's
not a feature we're doing in phase one", "you can put that in phase three", "we don't need to build
that right now", "let's save that for later", "not yet, after we validate the first version") where
the referent is clearly this same item, not a different one.

Confirm=false for anything short of that, including: a later statement about a different feature
that merely sounds similar or sits in the same general area; general discussion of what phase one
contains that never actually mentions excluding or deferring THIS feature; a vague "maybe later" or
"we'll see" with no clear referent to this specific item; enthusiasm or further discussion about the
SAME feature that does not defer it. When in doubt, confirm=false -- a real current-scope commitment
being kept active costs a user a moment's review when it turns out to be deferred later; wrongly
deferring it silently removes real active work with no easy way to notice.

Return schema-valid JSON: confirmed (boolean), reasoning (a precise sentence naming exactly what the
evidence does or does not show), and supporting_segment_ids (the subset of the segment IDs you were
given -- from either the original evidence or the proposed deferral evidence -- that most directly
support your answer; an empty array is acceptable when confirmed is false).
`.trim();

export const GROUPING_PROMPT = `
You are given the complete list of eligible work items for this meeting -- every item confirmed to
be accepted, current-scope, project_work, role=action or input_dependency -- plus the separate list
of current-scope acceptance-criterion items available to attach to whatever you group. Each item has
a stable ref, title, description, owner, status, its own exact source quote and segment IDs, and one
or two neighboring transcript turns for context only. You are not given topics, topic titles, the
full transcript, or any ineligible item. Future-scope, proposed, discussed-but-unaccepted, and
informational content does not exist as far as you are concerned.

Reason in this order:
1. Identify explicit deliverable anchors first: an accepted future result with an accountable
   owner, direct evidence, and (when available) a handoff, release, draft, deployment,
   presentation, or deadline. A deliverable anchor is the single biggest thing a participant
   explicitly promised to produce. A strategic or exploratory theme -- a pattern worth trying, a
   technique or skill someone is developing, general enthusiasm about an approach -- is never itself
   a deliverable anchor; it only qualifies once the transcript shows a concrete future outcome or
   experiment, an owner who accepted accountability for it, and a recognizable completion condition.
   General interest or discussion, however detailed, is not evidence of a commitment.
   ONE DELIVERABLE, ONE ANCHOR: if two or more candidate anchors would really describe the same
   underlying outcome -- one phrased narrowly (e.g. naming one piece of content or one release
   label), one phrased broadly (e.g. "first release" or "first draft"), or one that is really just
   an implementation step (e.g. connecting a domain, setting up a platform) toward the other -- they
   are the SAME anchor, not two. Pick the single formulation with the strongest direct
   accepted-deliverable evidence (a concrete handoff/release/presentation outcome and, when present,
   an explicit deadline) and build one anchor from it; do not also emit the narrower or component
   formulation as its own anchor.
2. RECAP/DELIVERABLE-DEFINITION ANCHORS: an acceptance-criterion item can itself be the anchor's
   seed, not merely something attached to an anchor you already built elsewhere. When an
   acceptance-criterion item states a final agreed deliverable or phase breakdown ("phase one is...",
   "the deliverable is...", "what we agreed is...", "the first version should...", "our goal for this
   phase is..."), treat it as a candidate anchor in its own right and actively check every eligible
   item for whether it is an implementation piece of the outcome that recap names -- a scattered
   earlier promise to build one named part of it (one feature, one step, one component) is a member
   of THAT anchor, not evidence for some other, unrelated anchor (such as an anchor about writing or
   sending a planning/status document, which is a different, administrative outcome even if the same
   person is involved). Build ONE new multi_item_shared_purpose group titled after the outcome the
   recap describes, with every matching implementation piece as a member and the recap item itself as
   its acceptance_criteria_refs entry -- do not leave the recap attached only to an unrelated
   administrative or documentation anchor while its actual implementation pieces remain scattered as
   standalone tasks. Only claim a member this way when it has direct textual/semantic support for
   contributing to the named outcome -- sharing a topic, owner, or rough timeframe with the recap is
   never sufficient by itself.
3. For each anchor, determine which eligible actions/input-dependencies materially advance it --
   including client/input dependencies the anchor cannot be completed without. An eligible item that
   just restates the anchor's own outcome in different words (e.g. the anchor is "deliver the first
   draft" and another item says "present the draft as soon as possible") is the SAME completion
   event as the anchor, not a separate contribution -- claim it as a member so it is represented once
   inside the anchor, rather than leaving it unclaimed to resurface as a duplicate standalone task.
4. Attach current-scope acceptance criteria that describe what the anchor must satisfy, in
   acceptance_criteria_refs -- these are requirements, never member_refs, never their own group. A
   product-scope decision (e.g. which product variants/lines to include) is an acceptance criterion
   on the anchor, never its own group.
5. Only after anchors are built, consider whether any remaining eligible items support another
   genuinely distinct outcome -- not a component of an anchor you already built.
6. Leave every remaining eligible item unclaimed; deterministic assembly makes it standalone.

Never create a peer group for something that is actually a component, requirement, or dependency of
an anchor you already identified -- fold it in instead. A single implementation action is never its
own group; a group is a broader outcome, never a restatement of one thing.

Declare group_basis:
- explicit_deliverable: exactly one member -- the single accepted action that itself already states
  the outcome (a deadline, a handoff, a release). explicit_outcome_evidence must be that item's own
  quote and segment IDs.
- multi_item_shared_purpose: two or more members that together serve one purpose broader than any
  one of them. Two items said close together are not thereby related; two items said far apart are
  not thereby unrelated -- proximity, shared topic, and shared owner are never sufficient reasons to
  group. Group only by what the work is actually for.
- explicit_zero_task_outcome: zero members, used only when your evidence for an accepted outcome
  does not trace to any item in the eligible list at all; this should be rare, since the
  reconciliation pass already turns real accepted outcomes into their own eligible item when
  possible.

Do not create a group that is just one item restated with a fancier title and no real added scope --
that item stays a standalone leaf by omission. An eligible item belongs to at most one group; an
acceptance criterion may be attached to at most one group. Only reference refs you were given.
Return only schema-valid JSON.
`.trim();

export const GROUPING_VERIFICATION_PROMPT = `
You are given the same eligible-item and acceptance-criteria lists grouping saw, and the proposed
groups. Your job is repair, not passive approval and not a rebuild from scratch: you may not invent
work items, invent requirements, reference a ref you were not given, use future-scope work as
current evidence, rewrite a work item's evidence, or create a new theme-based outcome not grounded
in the actual shared purpose of real member items.

For every proposed group, explicitly evaluate all fourteen:
1. Is this an accepted future outcome, not just a discussed idea?
2. Is it broader than each member action, or is it one action wearing a bigger title?
3. Does it represent a meaningful deliverable worth tracking on its own?
4. Does its title and description summarize the full member set (and attached acceptance criteria),
   not just one of them? A description of a first draft/first release must say so -- it must not
   read as if a narrower, later, or different-scope piece (e.g. only a policy page, or full
   e-commerce) is the whole deliverable.
5. Is it actually a component, requirement, dependency, or implementation step needed to complete a
   DIFFERENT proposed group? (Containment check -- see below.)
6. Is its owner the person accountable for the outcome, not merely one child-task owner promoted by
   default? Never set owner to a literal "Team" just because different people own different
   member tasks -- name the person accountable for the overall outcome, or leave owner null if none
   is clearly accountable; owners (plural) may still list every contributor.
7. Are other people correctly represented as owners of their own member tasks, not the group?
8. Does it contain only current-scope eligible work -- no future-scope, no proposal, no idea?
9. Are requirements attached via acceptance_criteria_refs rather than smuggled into member_refs?
   Each acceptance criterion must describe what THIS deliverable itself must satisfy -- not a
   prerequisite, input, or capability that belongs to a DIFFERENT system this deliverable merely
   depends on or consumes. E.g. if the deliverable is a tool that consumes structured meeting
   context another system produces, "that other system correctly identifies speakers/task owners"
   is a prerequisite of the other system, not an acceptance criterion of this one -- drop it from
   this group's acceptance_criteria_refs (it may still be a legitimate acceptance criterion on
   whatever group covers that other system's own deliverable, if one exists).
10. Are future features correctly absent from every group entirely?
11. Does the description invent scope no member or acceptance criterion actually supports? In
    particular: never state or imply email hosting/migration/service setup unless a member or
    criterion is itself explicitly about that (an email address being mentioned is not evidence);
    never state or imply that e-commerce/checkout/accounts/subscriptions are part of this
    deliverable when they are future-scope.
12. Does the description represent only one narrow child despite a broad title?
13. If this group's theme is strategic or exploratory (a pattern, technique, or skill to explore or
    develop), does the transcript show a concrete accepted future outcome or experiment, an
    accountable owner, and a recognizable completion condition -- not merely general interest,
    enthusiasm, or detailed discussion? Reject the group (or leave its members as informational/idea
    items) if the only evidence is discussion, no matter how technical or work-adjacent it reads.
14. Does the transcript explicitly make more than one person jointly accountable for THIS group's
    outcome? If not, its owner must be one person (or null), never every participant.

CONTAINMENT CHECK -- run this before anything else, exhaustively, for every pair of proposed
groups, not just the ones that look obviously related: "if this group were completed, would that
normally be considered only one component, requirement, dependency, or implementation step toward
the other group?" If yes, the two are not peers -- absorb the subordinate group's eligible members
and acceptance criteria into the surviving group, preserve all evidence/provenance, and remove the
subordinate group entirely. It must never survive as a peer commitment. This includes the case where
two groups are really the SAME underlying deliverable described at different levels of generality
(e.g. one titled after a broad "first release" and one titled after the same release but scoped to
one specific domain/platform detail) -- these are duplicates, not two commitments; merge them into
one rather than keeping both.

When two overlapping groups must be reduced to one, the SURVIVING group is decided by, in order:
1. strongest direct accepted-deliverable evidence (a concrete handoff/release/presentation outcome);
2. clearest single accountable owner;
3. clearest handoff/release/presentation outcome named in its own evidence;
4. an explicit deadline, when one group has it and the other doesn't;
5. the broadest genuine support from eligible child work, without becoming a vague theme.
Never let a narrower implementation action (e.g. one about connecting a domain or setting up one
platform) win over a group that states the actual deliverable -- the deliverable always outranks one
of its own implementation steps, no matter which was proposed first or which currently has a more
complete description.

Concrete examples of subordinate groups that must never survive as peers of the deliverable they
serve:
- Connecting an existing domain, or setting up hosting/deployment/email for it, to a deliverable --
  fold into the deliverable as a child task. Never invent a peer group about "email service setup"
  or infer any email-hosting/migration work merely because an email address was mentioned in
  passing; that is not evidence of accepted email-infrastructure work.
- Preparing one specific piece of content (a founder story, an FAQ, a policy page, product
  images/ingredients) for a deliverable -- fold in as a child task or acceptance criterion of the
  deliverable, never its own group.
- A product-scope decision such as which product variants/lines to include, or how they compare in
  a market -- this is an acceptance criterion or scope note on the deliverable, never its own group,
  unless the transcript states a separate, concretely accepted deliverable (its own owner, its own
  completion condition) to build or run something distinct.

MISSED RECAP-ANCHORED GROUP CHECK: before finalizing, check the acceptance-criteria list for any
item stating a final agreed deliverable or phase breakdown ("phase one is...", "the deliverable
is...", "what we agreed is...", "the first version should...", "our goal for this phase is...") that
is not currently the acceptance criterion of a group whose members are actually implementation
pieces of the outcome it names. If such a recap exists and one or more eligible items in the
supplied list are implementation pieces of that same named outcome -- even if grouping left them
standalone, or attached the recap only to a different, administrative/documentation group -- propose
the missing group yourself (ref=null), titled after the recap's outcome, with those items as members
and the recap as its acceptance criterion. Do not pull a member into this new group merely because it
shares a topic, owner, or timeframe with the recap -- it must have direct textual/semantic support
for being one of the outcome's actual parts. This is exactly the kind of missed group you are already
permitted to propose below; this check exists only to make sure you actually look for this specific
pattern, not to grant any new authority.

You may, for any group: keep it as proposed; correct its title, description, owner, due date,
purpose_reason, group_basis, member_refs, acceptance_criteria_refs, or explicit_outcome_evidence;
remove a member or acceptance-criterion ref that does not belong; move a member to a different group
where it actually belongs; absorb one group into another per the containment check; split a group
whose members actually serve two distinct purposes; reject it entirely if unsupported; or propose a
new group you believe grouping missed, built only from refs already supplied to you. When a broad
title pairs with a narrow description, rewrite the description to cover the whole member and
acceptance-criteria set, or reject the group if it cannot honestly be broadened.

Return the complete, corrected set of groups: echo a kept or corrected group's original ref, omit a
rejected or absorbed group entirely, and use ref=null for any group you are newly proposing (a
split half or a missed group) -- there is no limit on how many null-ref groups you may return. Every
ref you use in any group's member_refs or acceptance_criteria_refs must come from the supplied
lists. Return only schema-valid JSON.
`.trim();

export const TASK_CONSOLIDATION_PROMPT = `
You are given one commitment's shortlisted, plausibly-duplicate task clusters -- never the whole
task list, never other commitments' tasks -- along with each task's title, description, owner,
status, due date, source quote, and segment IDs. Each cluster was shortlisted by deterministic
matching (shared parent, compatible owner/status/date, overlapping evidence, similar title, or
similar combined title+description text); the shortlist is deliberately wide -- it can bundle
several genuinely distinct phases into one cluster on overlapping vocabulary alone -- so your job is
the semantic judgment a deterministic rule cannot make, including splitting a cluster back apart.

The only question that matters: "If this task were completed, would the other task also reasonably
be considered completed?" If yes, they may represent the same completion event and can merge. If no
-- they cover different, independently completable phases (setup, ingestion, evaluation, review,
communication, approval, deployment, content delivery are common distinct phases) -- they must
remain separate, even if they share a commitment, owner, topic, product, or occurred near each other
in the meeting. Sharing any of those alone is never sufficient reason to merge.

A single cluster may contain more than one genuine completion event. Partition it: return as many
proposals as there are distinct completion events among its tasks, each covering only the task_refs
that truly belong together. Every task_ref in the cluster must appear in exactly one of your
proposals for that cluster -- never omitted, never duplicated across proposals. A cluster where every
task is actually distinct still needs one keep_separate proposal per task (or one proposal listing
them all with disposition="keep_separate" if that is clearer) so every ref is accounted for.

For each resulting group of tasks, return one proposal:
- disposition="merge": the tasks are the same completion event. Provide canonical_title and
  canonical_description that honestly represent the merged scope (never broader than the union of
  what was merged, never inventing new work), and completion_equivalence explaining precisely why
  finishing one finishes the other.
- disposition="absorb_as_sequence_note": one task is actually a sequencing instruction about how or
  when to do another ("try X before Y"), not a separate deliverable -- record it as
  preserved_sequence_note attached to the surviving task rather than merging or discarding it.
- disposition="keep_separate": distinct completion events; state why in the reason field even
  though no merge happens, so the decision is auditable.

Never merge across a status conflict (completed with pending), an owner conflict, or a due-date
conflict, and never invent implementation detail beyond what the supplied tasks already state.
Reference only the task refs you were given. Set confidence honestly -- it determines whether a
merge auto-applies or is only suggested for review. Return only schema-valid JSON.
`.trim();
