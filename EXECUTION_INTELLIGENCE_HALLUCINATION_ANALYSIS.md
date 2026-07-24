# Execution Intelligence Hallucination Analysis

**Date:** 2026-07-23  
**Inputs:**

- `tests/fixtures/execution-intelligence.json`
- `tests/fixtures/execution-intelligence-live-predictions.json`
- `lib/execution-intelligence/evaluation.ts`

## Method

All 54 predicted objects across the 30 fixtures were compared with their
expected commitment/task labels. The production scorer matches commitments and
tasks separately, greedily and one-to-one, using token-set similarity:

```text
shared normalized tokens / max(expected token count, predicted token count)
```

A prediction is counted as matched at `>= 0.60`. Tokens of two characters or
fewer are discarded; there is no stemming, phrase normalization, synonym
handling, evidence matching, or cross-type matching.

The scorer identified 15 unmatched predicted objects in 11 fixtures. This
report manually adjudicates those 15 false positives. The other 39 predictions
that the scorer matched were also checked and did not add an unreported false
positive.

The predictions file does not retain `source_segment_ids`. The IDs below are
reconstructed exactly from the deterministic SHA-256 UUID transformation used
by `fixture-harness.ts`; every object in a fixture used that fixture's single
segment.

## False-positive adjudication

### 1. `pronoun` — predicted task

- **Transcript evidence:** `A: The API is broken. B: I'll look into it.`
- **Expected output:**
  - Commitment: `Investigate the broken API` — owner `B`
  - Task: `Investigate the broken API` — owner `B`
- **Predicted output:**
  - Commitment: `Investigate broken API` — owner `B`
  - Task: `Look into the broken API issue` — owner `B`
- **Source segment IDs:** `d890b4d7-2827-4df3-aedf-7f3e1d839740`
- **Classification:** **8. Title-normalization or semantic-matching failure**
- **Wrong party:** **Evaluator.** “Look into” and “investigate” express the
  same grounded action. Token similarity is `0.500` because the scorer does not
  normalize the phrase.
- **Recommended fix:** Matching fix. Add conservative verb-phrase
  normalization (`look into` → `investigate`) or supplement title matching with
  owner plus source-evidence overlap. Do not change the threshold.

### 2. `multiple-actions` — predicted task `Ping legal`

- **Transcript evidence:** `Maya: I'll update the docs and ping legal.`
- **Expected output:**
  - Commitment: `Update the docs and contact legal` — owner `Maya`
  - Tasks: `Update the docs`; `Contact legal` — owner `Maya`
- **Predicted output:**
  - Commitment: `Update the docs and ping legal` — owner `Maya`
  - Tasks: `Update the docs`; `Ping legal` — owner `Maya`
- **Source segment IDs:** `c0599288-5b70-49cb-a4ce-fc443f328a57`
- **Classification:** **8. Title-normalization or semantic-matching failure**
- **Wrong party:** **Evaluator.** The prediction preserves the transcript's
  exact verb and is more literal than the expected label. Similarity is `0.500`.
- **Recommended fix:** Dataset/matching fix. Prefer `Ping legal` in the expected
  label, or normalize `ping` and `contact` as equivalent action verbs.

### 3. `negation` — predicted task

- **Transcript evidence:** `Do not send the email until legal approves.`
- **Expected output:**
  - Commitment: `Wait for legal approval before sending the email`
  - Task: `Obtain legal approval`
- **Predicted output:**
  - Commitment: `Obtain legal approval before sending the email`
  - Task: `Get legal approval for the email`
- **Source segment IDs:** `f61f534b-f24c-4550-ac94-d84afa9d0e31`
- **Classification:** **8. Title-normalization or semantic-matching failure**
- **Wrong party:** **Evaluator.** `Get legal approval` is the same prerequisite
  as `Obtain legal approval`; similarity is only `0.333`.
- **Recommended fix:** Matching fix. Normalize `get`/`obtain` and tolerate
  grounded object expansion when source evidence and owner agree.

### 4. `conditional` — predicted commitment

- **Transcript evidence:** `If the deployment fails, roll back.`
- **Expected output:**
  - Commitment: `Roll back if deployment fails`
  - Task: `Roll back the deployment on failure`
- **Predicted output:**
  - Commitment: `Rollback deployment if it fails`
  - Task: `Execute rollback on deployment failure`
- **Source segment IDs:** `6929adae-851d-4522-accc-cc1cd3059119`
- **Classification:** **10. Scorer bug**
- **Wrong party:** **Evaluator.** The tokenizer treats `rollback` and
  `roll back` as unrelated tokens. The prediction preserves the condition.
  Similarity is `0.500`.
- **Recommended fix:** Scorer fix. Canonicalize compound action forms such as
  `rollback`/`roll back`, `follow-up`/`follow up`, and equivalent inflections
  before applying the unchanged `0.60` threshold.

### 5. `conditional` — predicted task

- **Transcript evidence:** `If the deployment fails, roll back.`
- **Expected output:**
  - Commitment: `Roll back if deployment fails`
  - Task: `Roll back the deployment on failure`
- **Predicted output:**
  - Commitment: `Rollback deployment if it fails`
  - Task: `Execute rollback on deployment failure`
- **Source segment IDs:** `6929adae-851d-4522-accc-cc1cd3059119`
- **Classification:** **10. Scorer bug**
- **Wrong party:** **Evaluator.** `Execute rollback on deployment failure` is
  the expected conditional action. Similarity is `0.400` because of compound
  tokenization and harmless verb expansion.
- **Recommended fix:** Scorer fix. Apply compound/stem normalization and
  evidence-aware matching before the fixed threshold.

### 6. `cross-topic` — second predicted commitment

- **Transcript evidence:** `A: We should launch AI search. Later B: I'll own the backend for that.`
- **Expected output:**
  - Commitment: `Launch AI search` — unassigned
  - Task: `Implement the AI search backend` — owner `B`
- **Predicted output:**
  - Commitments: `Launch AI search`; `Own the backend for AI search launch`
  - Task: `Own the backend for AI search launch` — owner `B`
- **Source segment IDs:** `bd433bfd-76b0-4897-a56e-bad87202f078`
- **Classification:** **5. Cross-topic duplication**
- **Wrong party:** **Model/pipeline.** B's later ownership statement should
  enrich/link a task beneath the existing launch commitment, not create a
  second overlapping commitment.
- **Recommended fix:** Dedupe/linking fix. Before final persistence, merge a
  later ownership commitment into an earlier broader commitment when evidence
  resolves the same object and the later action is a component of the earlier
  outcome.

### 7. `cross-topic` — predicted task

- **Transcript evidence:** `A: We should launch AI search. Later B: I'll own the backend for that.`
- **Expected output:**
  - Commitment: `Launch AI search` — unassigned
  - Task: `Implement the AI search backend` — owner `B`
- **Predicted output:**
  - Commitments: `Launch AI search`; `Own the backend for AI search launch`
  - Task: `Own the backend for AI search launch` — owner `B`
- **Source segment IDs:** `bd433bfd-76b0-4897-a56e-bad87202f078`
- **Classification:** **7. Commitment/task distinction mismatch**
- **Wrong party:** **Model.** `Own the backend` is a responsibility/
  commitment formulation, not a concrete execution task. It should resolve to
  implementation/ownership work under `Launch AI search`.
- **Recommended fix:** Prompt plus linking fix. Require task titles to use an
  executable action and link ownership clarifications to the existing broader
  commitment.

### 8. `group-owner` — second predicted task

- **Transcript evidence:** `Alex: Priya and I will review the PR.`
- **Expected output:**
  - Commitment: `Review the PR` — primary owner `Alex`
  - Task: `Review the PR` — primary owner `Alex`
- **Predicted output:**
  - Commitment: `Review the PR` — primary owner `Alex`
  - Tasks: `Review the PR by Alex`; `Review the PR by Priya`
- **Source segment IDs:** `a02cd219-a45a-482f-a972-9e79763260a0`
- **Classification:** **6. Group commitment split incorrectly**
- **Wrong party:** **Model/pipeline.** One jointly owned action was split into
  two duplicate execution tasks instead of one task with multiple owners.
- **Recommended fix:** Prompt/dedupe fix. Preserve `owners: [Alex, Priya]` on a
  single task and deduplicate same-action/same-evidence tasks before final
  verification.

### 9. `recurring` — predicted commitment

- **Transcript evidence:** `Every Monday Sam sends the KPI email.`
- **Expected output:**
  - Commitment: `Send the weekly KPI email` — owner `Sam`
  - Task: `Send the KPI email every Monday` — owner `Sam`
- **Predicted output:**
  - Commitment: `Sam sends the KPI email every Monday` — owner `Sam`
  - Task: `Send the KPI email` — owner `Sam`
- **Source segment IDs:** `a4fdbb29-66a7-4cfc-a531-3e92d3e34980`
- **Classification:** **8. Title-normalization or semantic-matching failure**
- **Wrong party:** **Evaluator.** The prediction is more literal and contains
  the same owner, action, object, and cadence. Similarity is `0.429`.
- **Recommended fix:** Matching fix. Ignore a duplicated owner token in titles
  when owner is already a structured field; normalize `every Monday` and
  `weekly` as equivalent cadence expressions.

### 10. `vague-date` — predicted task

- **Transcript evidence:** `Lee: I'll publish it after launch.`
- **Expected output:**
  - Commitment: `Publish after launch` — owner `Lee`
  - Task: `Publish after launch` — owner `Lee`
- **Predicted output:**
  - Commitment: `Publish it after launch` — owner `Lee`
  - Task: `Publish it` — owner `Lee`
- **Source segment IDs:** `3dc7442b-a4b4-475c-acc1-4faeb84bd786`
- **Classification:** **8. Title-normalization or semantic-matching failure**
- **Wrong party:** **Model.** The task is grounded, but its title drops the
  essential `after launch` condition. The evaluator is correct to distinguish
  it from the expected conditional task, although calling it a hallucination
  is misleading.
- **Recommended fix:** Prompt/schema fix. Require task titles or
  `due_date_text` to preserve unresolved event-relative timing. Add a
  deterministic post-check that inherits the parent commitment's condition
  when a linked task omits it.

### 11. `urgent` — predicted commitment

- **Transcript evidence:** `Urgent: Aditya needs to stop the signup outage.`
- **Expected output:**
  - Commitment: `Resolve the signup outage` — owner `Aditya`
  - Task: `Resolve the signup outage` — owner `Aditya`
- **Predicted output:**
  - Commitment: `Aditya needs to stop the signup outage` — owner `Aditya`
  - Task: `Stop the signup outage` — owner `Aditya`
- **Source segment IDs:** `f9d37c23-fcc0-403c-a5a8-6aba71dce01d`
- **Classification:** **8. Title-normalization or semantic-matching failure**
- **Wrong party:** **Evaluator.** `Stop the signup outage` and `Resolve the
  signup outage` represent the same grounded outcome. The commitment title
  redundantly includes the structured owner; similarity is `0.500`.
- **Recommended fix:** Matching fix. Remove structured owner/modal prefixes
  (`Aditya needs to`) before comparison and normalize `stop`/`resolve` for
  outage-remediation contexts.

### 12. `blocked` — predicted commitment

- **Transcript evidence:** `Sarah: I'll ship the update once security approves.`
- **Expected output:**
  - Commitment: `Ship the update after security approval` — owner `Sarah`
  - Tasks: `Get security approval` — unassigned; `Ship the update` — owner `Sarah`
- **Predicted output:**
  - Commitment: `Sarah will ship the update once security approves` — owner `Sarah`
  - Task: `Ship the update after receiving security approval` — owner `Sarah`
- **Source segment IDs:** `6973dddd-3ef9-4b6a-a932-702f31777faa`
- **Classification:** **8. Title-normalization or semantic-matching failure**
- **Wrong party:** **Evaluator.** The predicted commitment is semantically
  equivalent and preserves the blocking condition. Similarity is `0.500`
  because of owner/modal words and `approves` versus `approval`.
- **Recommended fix:** Matching fix. Strip owner/modal prefixes and stem
  `approves`/`approval`; use condition/evidence overlap as a tie-breaker.

### 13. `blocked` — predicted composite task

- **Transcript evidence:** `Sarah: I'll ship the update once security approves.`
- **Expected output:**
  - Commitment: `Ship the update after security approval` — owner `Sarah`
  - Tasks: `Get security approval` — unassigned; `Ship the update` — owner `Sarah`
- **Predicted output:**
  - Commitment: `Sarah will ship the update once security approves` — owner `Sarah`
  - Task: `Ship the update after receiving security approval` — owner `Sarah`
- **Source segment IDs:** `6973dddd-3ef9-4b6a-a932-702f31777faa`
- **Classification:** **7. Commitment/task distinction mismatch**
- **Wrong party:** **Model relative to the dataset's execution granularity.**
  The model folded the prerequisite into one conditional shipment task instead
  of emitting the expected unassigned approval task plus shipment task. The
  prediction is grounded, but it loses a separately trackable blocker.
- **Recommended fix:** Prompt/completeness fix. When a commitment is blocked by
  an explicit external approval, emit the approval as a separate unassigned
  prerequisite task and the dependent action as its own task.

### 14. `clarified-owner` — predicted commitment

- **Transcript evidence:** `A: Someone should own QA. B: Actually, Jordan will take QA.`
- **Expected output:**
  - Commitment: `Own QA` — owner `Jordan`
  - Task: `Run QA` — owner `Jordan`
- **Predicted output:**
  - Commitment: `Assign QA ownership to Jordan` — owner `Jordan`
  - Task: `Take ownership of QA` — owner `Jordan`
- **Source segment IDs:** `3d5f0e65-f1f0-4195-a06a-88c076205f93`
- **Classification:** **8. Title-normalization or semantic-matching failure**
- **Wrong party:** **Evaluator.** `Assign QA ownership to Jordan` captures the
  corrected commitment and correct owner. Lexical similarity is `0.000`
  because `QA` is discarded as a two-character token and `own` is not stemmed
  to `ownership`.
- **Recommended fix:** Scorer/matching fix. Preserve domain tokens such as
  `QA`, `AI`, and `PR`; stem `own`/`ownership`; compare structured owner.

### 15. `clarified-owner` — predicted task

- **Transcript evidence:** `A: Someone should own QA. B: Actually, Jordan will take QA.`
- **Expected output:**
  - Commitment: `Own QA` — owner `Jordan`
  - Task: `Run QA` — owner `Jordan`
- **Predicted output:**
  - Commitment: `Assign QA ownership to Jordan` — owner `Jordan`
  - Task: `Take ownership of QA` — owner `Jordan`
- **Source segment IDs:** `3d5f0e65-f1f0-4195-a06a-88c076205f93`
- **Classification:** **7. Commitment/task distinction mismatch**
- **Wrong party:** **Model.** The task repeats the ownership commitment rather
  than producing executable QA work. The expected `Run QA` is an inferred
  execution step; if that inference is desired, it must be marked inferred.
- **Recommended fix:** Prompt fix. Reject tasks that merely restate ownership;
  either emit a concrete inferred task (`Run QA`, `inferred=true`) or leave the
  commitment without a task when no execution step is safely inferable.

## Summary

### Counts

- **Predicted objects audited:** 54
- **Scorer-unmatched predicted objects:** 15
- **Fixtures containing unmatched predictions:** 11
- **Total genuine hallucinations:** **0**
- **Total evaluator mismatches:** **9**
- **Total model/pipeline representation errors:** **6**
- **Total duplicates:** **2**
  - 1 cross-topic duplicate commitment
  - 1 incorrectly split group task
- **Total over-inferred tasks:** **0**

The reported `0.2278` hallucination rate is a macro-average of each fixture's
unmatched-prediction fraction. It is not `15 / 54`. The name “hallucination
rate” currently conflates unsupported content, lexical matching failures,
duplicates, and commitment/task granularity differences.

### Classification totals

- **5. Cross-topic duplication:** 1
- **6. Group commitment split incorrectly:** 1
- **7. Commitment/task distinction mismatch:** 3
- **8. Title-normalization or semantic-matching failure:** 8
- **10. Scorer bug:** 2
- All other classifications: 0

### Top three root causes

1. **Lexical-only evaluator matching** — 9 false positives. It misses
   synonyms, owner/modal prefixes, compounds, cadence equivalence, inflection,
   and two-character domain terms.
2. **Commitment/task granularity errors** — 4 false positives: the cross-topic
   ownership task, vague-date condition loss, collapsed blocked prerequisite,
   and clarified-owner task restatement.
3. **Cross-topic/group deduplication gaps** — 2 false positives: one duplicate
   commitment and one duplicated group task.

### Expected metric improvement

These estimates use the current macro-averaged scorer and assume each targeted
case is corrected without changing the `0.60` match threshold.

1. **Evidence-aware semantic normalization in the evaluator**
   - Corrects the 9 evaluator mismatches.
   - Expected hallucination-rate reduction: approximately **0.1444**.
   - Expected rate: **0.0833** from the current `0.2278`.
   - This is not threshold weakening; it makes existing matches semantically
     faithful while preserving the same acceptance cutoff.

2. **Commitment/task granularity prompt and completeness fixes**
   - Corrects 4 model representation errors.
   - Expected hallucination-rate reduction: approximately **0.0611**.
   - Expected rate independently: **0.1667**.

3. **Cross-topic and group-owner deduplication**
   - Corrects 2 duplicate outputs.
   - Expected hallucination-rate reduction: approximately **0.0222**.
   - Expected rate independently: **0.2056**.

Applying both model-side fixes (2 and 3) without changing the evaluator is
expected to reduce the measured rate to approximately **0.1444**, just below
the existing `0.15` threshold. Applying all three fixes should make all 15
currently unmatched predictions match or disappear, while leaving the
threshold unchanged.

## Recommended order

1. Fix cross-topic and group deduplication first because those are actual graph
   quality defects.
2. Fix commitment/task granularity for blockers, ownership restatements, and
   event-relative conditions.
3. Improve evaluator normalization and evidence-aware matching, with regression
   tests for every case above.
4. Rerun all 30 live fixtures and retain the existing thresholds.

