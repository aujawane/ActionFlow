# Scenario — Meeting 2: Engineering / Debugging

**Frozen design specification, written before the transcript and ground truth. See Meeting 1's
scenario.md for the general process note; it applies here too.**

## Meeting purpose

Three engineers jump on a call to debug a production issue together: large-account report exports
have started timing out. This is a live, in-the-moment troubleshooting session, not a status
update — most of the real content is them pulling logs and reasoning out loud, with the actual
follow-up commitments landing in the back half of the call.

## Participants

- **Nadia** — on-call engineer, first to notice the issue
- **Ravi** — backend engineer
- **Tom** — engineering lead

## Intended actions completed during the meeting

1. **Nadia pulls the error logs and identifies the root cause live on the call** — the export job
   is timing out on the S3 upload step for large files.
2. **Ravi restarts a stuck worker process** while they're on the call, to unblock the current queue
   immediately. This is a real, completed action, separate from the follow-up fix.

## Intended post-meeting commitments (active)

1. **Ravi adds a timeout + retry around the S3 upload call** in the export job — the actual fix.
2. **Tom creates a separate verification task**: after Ravi's fix ships, someone needs to confirm
   large-account exports succeed in staging. This is explicitly a *different, later* action from
   the fix itself — tests that a fix and its verification don't collapse into one item.
3. **Nadia adds better logging/alerting** around the export job so a timeout like this is caught
   before a customer reports it next time.
4. **Tom will message the customer** who originally reported the issue to let them know a fix is
   coming.
5. **Nadia keeps investigating whether the same timeout risk affects the small-account export
   path** — she starts looking at this during the call itself but does not finish; it remains open,
   explicitly unfinished work, not a completed action and not a brand-new ask either.

## Intended negative (explicitly rejected solution)

- They discuss **just bumping the worker's memory limit** as a quick possible fix, and explicitly
  decide against it ("that's just papering over it, let's not do that"). This must not appear as a
  commitment in either direction.

## Intended negative (retrospective statement)

- Tom mentions, in passing, that **the old exporter had a similar timeout issue roughly six months
  ago**. This is a historical remark for context, not a new task, and not something anyone is
  asked to look into now.

## Tricky cases

- The two completed-during-meeting actions (Nadia's log investigation, Ravi's worker restart) must
  not leak into the active commitments list — they are already done, and Parfait must not
  separately invent a future-tense task for either of them.
- The "fix" (Ravi's timeout/retry) and the "verification" (Tom's staging check) are about the same
  underlying incident and use a lot of the same vocabulary ("export", "large account", "S3",
  "timeout") — this is the suite's dependency/sequencing precision test: one cannot substitute for
  the other.
- Nadia's unfinished small-account investigation is intentionally phrased as *continuing* existing
  work ("I started looking... I didn't get all the way through it, I'll pick that up after this"),
  not as a fresh request — tests recognition of "started but still open" as its own lifecycle state,
  distinct from both "completed during meeting" and a brand new ask.
- The declined memory-limit idea is proposed using nearly the same urgency/language as the accepted
  fix ("we could just...") — tests that an explicitly-declined alternative doesn't get scored as a
  commitment just because it was seriously discussed.

## Ownership changes

None in this meeting (see Meeting 4).

## Dependency relationships

Tom's verification commitment (#2 above) is implicitly sequenced after Ravi's fix (#1) ships — the
verification cannot happen first. This is a lighter-weight dependency than Meeting 4's explicit
blocking dependency, expressed only through the natural order/logic of the conversation.

## Transcript-noise plan

Technical, screen-sharing-style dialogue ("can you see my screen", "pull up the logs", "yeah scroll
down"). Natural interruptions while people talk over log output. No ASR corruption in this meeting.

## Target size

Roughly 55–70 transcript segments; ~12–15 minutes of conversation.
