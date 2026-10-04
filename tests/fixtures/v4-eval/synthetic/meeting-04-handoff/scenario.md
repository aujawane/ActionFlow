# Scenario — Meeting 4: Planning / Handoff

**Frozen design specification, written before the transcript and ground truth.**

## Meeting purpose

Planning the rollout of a new "team permissions" feature across several people, with real
dependencies and a mid-meeting change of who owns what. This is the suite's multi-owner /
dependency / ownership-transfer-heavy meeting.

## Participants

- **Grace** — product manager, runs the meeting
- **Owen** — backend engineer
- **Mia** — frontend engineer
- **Derek** — engineer, handles docs/integrations work

## Intended active commitments (7)

1. **Owen builds the backend API** for team permissions.
2. **Mia builds the permissions UI** — explicitly cannot start the real implementation until
   Owen's API is in place (**dependency**: Mia's work is blocked on Owen's).
3. **Owen and Mia pair on the data-migration script** together (**multi-owner** work — both named,
   both actually doing it, not one delegating to the other).
4. **Mia writes the migration documentation** — Derek originally offers to do this, but Grace
   redirects it to Mia mid-conversation because Mia has more context by then (**ownership
   transfer**: Derek offers first, Mia ends up with it, Derek does NOT end up owning this one).
5. **Derek handles customer comms** about the upcoming rollout — Grace asks early in the meeting;
   nobody responds right away; Derek circles back and accepts several turns later, after other
   topics have been discussed in between (**accepted request, but only several turns later**).
6. **Grace schedules the go/no-go review meeting** for next Friday (**scheduling commitment**).
7. **Derek updates the external API docs AND separately notifies the partner-integrations team**
   about the upcoming change (**compound commitment** — two independently-checkable outcomes
   under one ask).

## Intended negative

- **Declined/unanswered request:** Grace asks if anyone can also write up a rollback plan this
  sprint. Nobody takes it — it gets acknowledged as a good idea in the abstract but explicitly
  pushed to "whenever, no rush," which is not an acceptance.

## Intended negative (completed action mentioned retrospectively)

- Partway through, Derek mentions, almost in passing, that **he already sent the beta-customer
  announcement email last week** — this already happened, before this meeting, and is mentioned
  only to explain context for something else. It must not be read as active work, and specifically
  must NOT be read as "completed during this meeting" either, since it happened before the meeting
  started.

## Tricky cases

- **Ownership transfer:** Derek's offer ("I can write that up") and Mia's eventual acceptance
  ("yeah sure, I can do that") happen within the same short exchange, with Grace steering it in
  between — the final, real owner of the migration docs is Mia, not Derek. A correct extraction
  must not credit Derek with this one just because he spoke first.
- **Dependency:** Mia explicitly says she can't meaningfully start her side until Owen's API
  exists ("I mean I can start on some of the UI shell, but the real wiring has to wait until your
  endpoints exist") — this must not be read as Mia already starting active work independent of
  Owen's.
- **Delayed acceptance:** Grace's ask about customer comms and Derek's eventual "yeah, I'll take
  that one" are separated by a full unrelated exchange about scheduling — tests that acceptance
  doesn't have to be adjacent to the request to count.
- **Similar-but-different tasks:** Owen's backend API work and the Owen+Mia migration script pairing
  are both "Owen, permissions, backend-ish work," discussed close together — these are two
  genuinely distinct deliverables and must not merge into one item.
- **Repeated discussion, no duplicate:** the migration script is referenced three separate times
  (when first proposed, when scope is clarified, and again near the end as a timeline check) — one
  commitment throughout.
- **Retrospective, not completed-during-meeting:** Derek's mention of the beta email he already
  sent last week must not be scored as either an active item or a `completed_during_meeting` item
  — it is neither; it is simply not part of this meeting's work at all.

## Ownership changes

Yes — see commitment #4 above (Derek offers, Mia actually owns it).

## Dependency relationships

Yes — see commitment #2 above (Mia's UI work depends on Owen's API work).

## Transcript-noise plan

Natural planning-meeting dialogue: people thinking out loud, light interruptions, one person
trailing off and someone else finishing the thought. No ASR corruption in this meeting.

## Target size

Roughly 65–85 transcript segments; ~15–18 minutes of conversation.
