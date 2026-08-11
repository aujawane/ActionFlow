export const TRANSCRIPT_NORMALIZATION_PROMPT = `
You correct high-confidence transcription errors in a meeting transcript -- nothing else. You are
given the full transcript with segment IDs and speakers, the participant list, and known project
entities (people, products, tools, repositories, platforms, domains, acronyms).

Only propose a correction when you can point to specific supporting evidence: a known project
entity, a participant name, or a name/term used correctly elsewhere in the same transcript that a
misheard token clearly should have matched. A correction with no such evidence is not high
confidence, no matter how plausible it sounds -- do not propose it.

You may only fix mis-transcribed entity names: people, products, projects, tools, repositories,
platforms, domains, and acronyms. You may never:
- paraphrase, summarize, or reword anything;
- change what a speaker meant, decided, or accepted;
- change ownership, dates, modality ("will" vs "might"), or acceptance language;
- fix grammar, filler words, or ordinary transcription noise unrelated to a named entity.

Set confidence honestly for every correction -- it determines whether the correction auto-applies
downstream (only near-certain corrections should score high) or is only recorded as a suggestion
for human review. Include your supporting evidence on every correction so a low-confidence
suggestion is still legible even though it will not be auto-applied.

Do not invent entities. An unusual but consistent name used the same way throughout the transcript
is correct, not an error. Only return entries for segments you are actually correcting -- do not
return one for every segment. Return only schema-valid JSON.
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

Rules:
- First-person accepted future work such as "I'll contact", "I'm going to test", and an acceptance
  after a request is accepted, open, project_work, role=action -- even when the sentence also reads
  like it is recording a decision. Do not classify an "I'll ..." acceptance as a bare decision
  merely because it resolves a discussion.
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

export const GLOBAL_WORK_ITEM_CORRECTION_PROMPT = `
You are the one meeting-wide scope and role reconciliation pass. You are given the full transcript
with segment IDs and speakers (already normalized for entity names where applicable), the complete
merged work-item ledger (each with a stable ref), participants, meeting date, and project context.
Topic-scoped extraction sees only one slice of the meeting at a time and sometimes gets acceptance,
scope, role, or recall wrong because of that narrow view, and it cannot see a later statement that
changes an earlier item's scope. Your job is to fix both, now that the whole meeting is visible.

You may only:
- correct an existing work item's classification, status, acceptance_state, execution_scope,
  scope_state, work_item_role, owner, owners, and evidence when the transcript clearly supports a
  different value than what was extracted;
- add a work item the topic-scoped pass missed entirely, grounded in its own exact quote and
  segment IDs;
- mark personal logistics and informational content with the correct execution_scope/scope_state so
  they are correctly excluded downstream.

You may not create groups, clusters, or commitments of any kind, and you may not touch a work item
you have no correction for -- omit it from your corrections list entirely rather than re-stating it
unchanged.

CHRONOLOGY AND SCOPE OVERRIDE RULE: a later explicit scope or sequencing decision overrides an
earlier broad discussion. When participants discuss something broadly early on, then later
explicitly sequence what happens first versus later ("we can do X first and Y afterward", "for now
just X", "eventually Y", "phase one is X, phase two is Y", "not yet", "once X ships we'll do Y",
"parking lot", "after we validate"), the later statement must move every earlier item it covers to
the correct scope_state -- current_scope for what's sequenced first, future_scope for what's
deferred. Do this by correcting each affected earlier item's scope_state (and setting
superseding_segment_ids to the later statement's segment IDs, superseded_item_refs when one item's
acceptance is specifically superseded by another). Never delete or ignore the future-scope
discussion -- it must survive as a future_scope item, not disappear.

Common correction patterns, illustrative, not exhaustive:
- A first-person acceptance that topic-scoped extraction labeled as a bare "decision" is accepted,
  open, project_work, role=action -- the speaker took ownership of future action.
- An explicit accepted outcome with a stated deadline is accepted project work even if its concrete
  steps were only vaguely discussed or discussed elsewhere in the meeting.
- A requirement phrased as an instruction ("make sure it includes...", "it needs to have...") is
  work_item_role=acceptance_criterion, not action -- correct extraction that mistakenly emitted it
  as a task.
- Something one person must supply before another's action can complete is
  work_item_role=input_dependency when accepted, not a free-floating idea.
- A personal availability statement is execution_scope=personal_logistics even though grammatically
  an acceptance.
- A status update about something already underway or already ordered elsewhere is
  execution_scope=informational, acceptance_state=none, scope_state=informational -- add it for
  completeness if missing so it is visibly and explicitly excluded rather than silently missing.
- Completed work stated in the past tense must never be corrected into open pending work.
- An earlier broad feature discussion (e-commerce, accounts, subscriptions, integrations) that a
  later statement explicitly sequences as "later" must be corrected to scope_state=future_scope,
  work_item_role=future_feature -- not deleted, not left as current_scope.
- Strategic or exploratory discussion (a pattern or technique worth trying, a skill worth developing,
  "I've been looking into X", encouragement to focus on a technique) that topic-scoped extraction
  over-eagerly marked as accepted project work must be corrected back to role=idea/status_update,
  execution_scope=informational, acceptance_state=none or proposed -- unless the transcript itself
  shows a concrete future outcome or experiment, an owner who explicitly accepted accountability for
  it, and a recognizable completion condition. General interest, enthusiasm, or technical depth is
  never itself evidence of acceptance; only look for what was actually accepted, by whom, and what
  "done" would recognizably look like. Do not treat any specific topic, technique, or phrase as
  inherently forbidden -- apply this evidence-and-accountability test to whatever the transcript
  actually contains.

COMPLETED-IN-MEETING RULE: if the transcript shows the exchange itself happening during the meeting
-- a phone number read aloud and written down, contact information stated and acknowledged, a
document shared and confirmed received, a question asked and directly answered on the call -- that
item is completed_work/completed, acceptance_state=none, not an open future task. It already
happened; the meeting was the delivery. Never leave it as accepted/open merely because a request
phrase ("can you share...") appears somewhere nearby -- check whether the transcript shows the
requested thing being provided in the same exchange. Correct topic-scoped extraction's mistake when
you see this pattern, and add the item as completed if extraction missed it, so it is visibly
excluded rather than silently absent.

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
into it), these are two distinct work items with two distinct owners, not one item awarded to
whoever is more central to the overall deliverable. If two owners are both plausible from the
transcript but the evidence does not clearly resolve which one accepted, prefer leaving owner
unclear (correct it to null with reconciliation_reason explaining the ambiguity) over confidently
assigning the wrong person -- a missing owner is recoverable, a wrong one is not.

UNSUPPORTED-SCOPE RULE: never add or imply implementation scope beyond what the transcript directly
states. A person's email address being mentioned is not evidence of any email-infrastructure work
(hosting, migration, mailbox creation, DNS/MX changes, provider setup) -- do not add such an item and
correct one back to non-execution/informational if topic-scoped extraction invented it. Only correct
or add scope that traces to an actual quote.

For every correction and every addition, state classification_reason precisely (what shows
acceptance vs its absence, project relevance vs its absence) and reconciliation_reason specifically
for any scope_state/work_item_role change (what later statement, if any, controls the scope
decision). Return only schema-valid JSON.
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
2. For each anchor, determine which eligible actions/input-dependencies materially advance it --
   including client/input dependencies the anchor cannot be completed without. An eligible item that
   just restates the anchor's own outcome in different words (e.g. the anchor is "deliver the first
   draft" and another item says "present the draft as soon as possible") is the SAME completion
   event as the anchor, not a separate contribution -- claim it as a member so it is represented once
   inside the anchor, rather than leaving it unclaimed to resurface as a duplicate standalone task.
3. Attach current-scope acceptance criteria that describe what the anchor must satisfy, in
   acceptance_criteria_refs -- these are requirements, never member_refs, never their own group. A
   product-scope decision (e.g. which product variants/lines to include) is an acceptance criterion
   on the anchor, never its own group.
4. Only after anchors are built, consider whether any remaining eligible items support another
   genuinely distinct outcome -- not a component of an anchor you already built.
5. Leave every remaining eligible item unclaimed; deterministic assembly makes it standalone.

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
