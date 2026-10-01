# Scenario — Meeting 5: Messy / ASR-Noisy

**Frozen design specification, written before the transcript and ground truth.**

## Meeting purpose

A quick, scrappy internal sync for a small team building a meeting-productivity tool (fictional,
not modeled on any real customer meeting). This is the suite's hardest transcript on purpose:
realistic transcription noise layered over genuine commitments, to test whether noise degrades
extraction quality.

## Participants

- **Theo** — engineer (backend/infra)
- **Nina** — engineer (deploy/release)
- **Pavan** — engineer (the "Chatter"-style conversational agent)
- **Bex** — support/ops

## Intended active commitments (4)

1. **Theo fixes a database connection-pooling issue** on their Supabase-backed service.
2. **Pavan fixes a duplicate-message bug** in the "Chatter" conversational agent.
3. **Bex updates the status page AND separately notifies the one customer who complained**
   (**compound commitment**).
4. **Theo adds a monitoring alert** for the feature-flag service restarts, specifically created as
   a follow-up *because of* the live restart in this same meeting (**active follow-up created
   after an in-meeting fix** — distinct from the restart itself, which is already done).

## Intended verification action

- **Nina verifies the deploy preview still works** after Theo's connection-pooling fix ships —
  a check/verification action, sequenced after the fix, not the fix itself.

## Intended completed-during-meeting action

- **Nina restarts the "Beacon" feature-flag service live on the call**, to clear a flag that's
  stuck, and confirms it's back up before they move on.

## Intended negative

- Someone raises, almost excitedly, "what if we just rebuilt the whole notification system from
  scratch" — phrased in a way that sounds like a real, scoped task, but is explicitly left as a
  someday-maybe with no owner and no decision.

## Tricky cases (realism / noise)

- **ASR-style misheard terms**, each appearing at least once: "Supabase" → "super base", "Vercel"
  → "versel", "Chatter" → "chapter".
- **One misheard product/feature name**: the internal feature-flag service "Beacon" is misheard
  once as "bacon," played completely straight by the transcript (no joke acknowledged in-line).
- Interruptions, stutters, self-corrections, unfinished sentences, pronoun-heavy references
  ("he already looked at that," "she's on it").
- One duplicated short phrase within a single turn (an ASR-style glitch, e.g. a repeated "I think
  I think").
- One truncated sentence that just cuts off.
- One speaker turn that's unnaturally split into two consecutive segments (same speaker,
  continuing their own thought, as if the transcription pipeline cut it at the wrong point).
- At least one segment with missing/dropped punctuation.
- Indirect acceptance for at least one commitment (agreement implied, not stated outright).

## Ownership changes

None.

## Dependency relationships

Nina's verification action is sequenced after Theo's fix, similar in spirit to Meeting 2's
fix/verify pairing, but expressed more loosely given the noisier dialogue style.

## Transcript-noise plan

This is the one meeting where ASR-style noise is deliberately introduced (see "tricky cases"
above). Noise must stay legible — a human reading the transcript must still be able to determine
ground truth with confidence. Noise is layered onto an otherwise coherent set of real commitments,
not used to obscure them entirely.

## Target size

Roughly 55–75 transcript segments; ~12–15 minutes of conversation.
