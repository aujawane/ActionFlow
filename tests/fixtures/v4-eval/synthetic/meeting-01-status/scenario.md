# Scenario — Meeting 1: Normal Team Status

**This file is the frozen design specification. It is written BEFORE the transcript and BEFORE the
ground truth. The transcript is generated from this scenario; the ground truth describes this
scenario's intended semantic reality, not the transcript's literal wording. Once all three files
(this one, `transcript.ts`, `ground-truth.ts`) exist, they are frozen together and must not be
edited to match any extraction system's behavior.**

This document is benchmark design documentation only. It intentionally does not reference V4,
WorkItem fields, or any implementation detail of the extraction pipeline.

## Meeting purpose

A normal weekly team status/sync for a small internal-tools team ("Lighthouse" admin dashboard).
Nothing special is happening — it's a routine check-in with the usual mix of real work, half-settled
asks, a tangent, and one thing someone just fixes on the call.

## Participants

- **Maria** — product manager, runs the meeting
- **Devon** — engineer
- **Priya** — engineer
- **Sam** — designer

## Intended active commitments

1. **Devon fixes the admin table pagination bug.** Fairly explicit acceptance, but phrased casually
   mid-conversation, not as a clean declarative sentence.
2. **Priya looks into the slow dashboard queries.** An *indirect* commitment — she doesn't say "I
   will investigate," she says something closer to "yeah I can probably poke at that this week,"
   while already mid-sentence about something else.
3. **Sam updates the onboarding mockups** based on feedback from last week. This is discussed
   **twice** in the meeting (once early when Maria raises it, once near the end as a casual
   check-in on progress) — it must remain ONE commitment, not two.
4. **Devon looks at the CSV export feature request** from support. Maria asks directly; Devon
   accepts it in the same breath as agreeing to something else, so it's easy to conflate with #1
   (same person, same general "admin area") — this is the suite's **similar-but-different-tasks**
   duplication risk for this meeting, since both are "Devon does something in the admin dashboard,"
   but they are two distinct, separately-trackable pieces of work.
5. **Maria will put together a first draft of the Q3 roadmap doc** and share it before next week's
   meeting.

## Intended completed-during-meeting action

- **Priya notices a broken link in the internal docs while screen-sharing something unrelated, and
  just fixes it live on the call.** Explicitly resolved during the meeting, not a follow-up.

## Intended negatives

1. **Unanswered request:** Maria asks if anyone can present the Lighthouse roadmap at next week's
   all-hands. Nobody answers directly; the conversation moves on without anyone taking it.
2. **Speculative/hypothetical:** Someone mentions, in passing, that they should "really look into
   switching CI providers at some point" — a passing frustration, not a proposal anyone engages
   with or accepts.
3. **Informational statement:** Maria mentions the office will be closed Monday for a holiday. Pure
   logistics announcement — must never be read as a task for anyone.

## Tricky cases

- The Sam/mockups commitment is raised twice, several minutes apart, with slightly different
  wording each time ("can you take another pass at the onboarding flow" vs. "how's the onboarding
  stuff coming") — tests duplicate suppression across a repeated topic.
- Devon's two commitments (#1 pagination fix, #4 CSV export) both live in "the admin dashboard" and
  are discussed back-to-back — tests that superficially similar context doesn't collapse two real,
  distinct asks into one, or bleed one's details into the other.
- The CI-providers comment (negative #2) is said by the same person (Devon) who has two real
  commitments already, in the same general tone of voice as his real commitments — tests that
  speaker identity/tone alone doesn't make something a commitment.
- The all-hands ask (negative #1) gets a half-reaction ("hmm, maybe") before the topic changes —
  deliberately NOT a real acceptance.

## Ownership changes

None in this meeting (see Meeting 4 for ownership-transfer scenarios).

## Dependency relationships

None in this meeting (see Meeting 4 for dependency scenarios).

## Transcript-noise plan

Light, natural noise only: filler words ("uh", "yeah", "I think"), a couple of interruptions, one
false start, one self-correction, mid-sentence topic drift. No ASR-style word corruption in this
meeting (reserved for Meeting 5). One short, genuinely unrelated side conversation (a weekend/
conference tangent) must be present and must not generate any ground-truth item.

## Target size

Roughly 55–70 transcript segments; ~12–15 minutes of conversation.
