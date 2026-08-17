import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CORRECTABLE_COMMITMENT_FIELDS,
  commitmentCorrectionChangeSchema,
  commitmentCorrectionResponseSchema
} from "../lib/commitment-correction/schema";
import { buildCommitmentCorrectionContext } from "../lib/commitment-correction/context";
import { validateCommitmentCorrectionChanges } from "../lib/commitment-correction/validate";
import type { CommitmentCorrectionChange } from "../lib/commitment-correction/schema";
import type { MeetingCommitment } from "../lib/types";

function commitment(overrides: Partial<MeetingCommitment> = {}): MeetingCommitment {
  return {
    id: "commitment-1",
    meeting_id: "meeting-1",
    topic_id: null,
    title: "Finalize Bloom Base storyboard",
    description: "Complete the storyboard for the Bloom Base project.",
    owner: "Francesca Todarello",
    owners: ["Francesca Todarello", "Aditya Ujawane"],
    lead_owner_name: "Francesca Todarello",
    due_date: "2026-08-11",
    due_date_text: null,
    priority: "medium",
    status: "pending",
    confidence: 0.9,
    source_quote: null,
    source_segment_ids: [],
    type: "assignment",
    completion_state: "open",
    execution_classification: "committed",
    metadata: {},
    manual_override_fields: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function change(overrides: Partial<CommitmentCorrectionChange>): CommitmentCorrectionChange {
  return {
    field: "due_date",
    current_value: "2026-08-11",
    proposed_value: "2026-08-20",
    supporting_person_from: null,
    confidence: 0.95,
    ...overrides
  };
}

const PARTICIPANTS = ["Aditya Ujawane", "Cameron Brock", "Francesca Todarello", "Hannah Just Milender"];

// ============================================================
// 1. freeform due-date correction -> structured due_date proposal
// ============================================================

test("validate: a due-date change resolves into a due_date patch with a human-readable summary", () => {
  const result = validateCommitmentCorrectionChanges([change({ field: "due_date", proposed_value: "2026-08-20" })], {
    commitment: commitment(),
    participantOptions: PARTICIPANTS
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.patch, { due_date: "2026-08-20" });
  assert.deepEqual(result.summaries, [{ field: "Due date", from: "2026-08-11", to: "2026-08-20" }]);
});

test("validate: an invalid resolved date is rejected rather than persisted", () => {
  const result = validateCommitmentCorrectionChanges(
    [change({ field: "due_date", proposed_value: "2026-02-30" })],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, false);
});

test("validate: a relative/unresolved date string is rejected -- the agent must resolve to YYYY-MM-DD before this layer sees it", () => {
  const result = validateCommitmentCorrectionChanges(
    [change({ field: "due_date", proposed_value: "next Friday" })],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, false);
});

// ============================================================
// 2. freeform owner correction -> resolved participant
// ============================================================

test("validate: an owner change resolves against the real participant list and produces lead_owner_name", () => {
  const result = validateCommitmentCorrectionChanges(
    [change({ field: "owner", current_value: "Francesca Todarello", proposed_value: "Aditya Ujawane" })],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.patch, { lead_owner_name: "Aditya Ujawane" });
  assert.deepEqual(result.summaries, [
    { field: "Owner", from: "Francesca Todarello", to: "Aditya Ujawane" }
  ]);
});

test("validate: 'Unassigned' is a valid owner target, mapping to null", () => {
  const result = validateCommitmentCorrectionChanges(
    [change({ field: "owner", proposed_value: "Unassigned" })],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.patch.lead_owner_name, null);
});

test("validate: a hallucinated/unlisted owner name is rejected -- defense-in-depth, never trust the model just because it passed JSON schema validation", () => {
  const result = validateCommitmentCorrectionChanges(
    [change({ field: "owner", proposed_value: "Someone Not In This Meeting" })],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, false);
});

// ============================================================
// 3. supporting-person replacement
// ============================================================

test("validate: a supporting-person replacement swaps only the matched entry, owner untouched", () => {
  const result = validateCommitmentCorrectionChanges(
    [
      change({
        field: "supporting_person",
        supporting_person_from: "Aditya Ujawane",
        current_value: "Aditya Ujawane",
        proposed_value: "Cameron Brock"
      })
    ],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.patch, { owners: ["Francesca Todarello", "Cameron Brock"] });
  assert.ok(!("lead_owner_name" in result.patch));
  assert.ok(!("owner" in result.patch));
});

test("validate: supporting_person_from must match a real current supporting person, not just any string", () => {
  const result = validateCommitmentCorrectionChanges(
    [change({ field: "supporting_person", supporting_person_from: "Someone Else", proposed_value: "Cameron Brock" })],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, false);
});

test("validate: a commitment with no supporting people rejects a supporting_person change entirely", () => {
  const result = validateCommitmentCorrectionChanges(
    [change({ field: "supporting_person", supporting_person_from: "Aditya Ujawane", proposed_value: "Cameron Brock" })],
    { commitment: commitment({ owners: ["Francesca Todarello"] }), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, false);
});

// ============================================================
// 4/5/6. title / priority / status corrections
// ============================================================

test("validate: a title correction", () => {
  const result = validateCommitmentCorrectionChanges(
    [
      change({
        field: "title",
        current_value: "Finalize Bloom Base storyboard",
        proposed_value: "Complete the final Bloom Base storyboard"
      })
    ],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.patch, { title: "Complete the final Bloom Base storyboard" });
});

test("validate: a priority correction normalizes case and validates against the enum", () => {
  const result = validateCommitmentCorrectionChanges(
    [change({ field: "priority", current_value: "medium", proposed_value: "High" })],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.patch, { priority: "high" });
});

test("validate: an invalid priority value is rejected", () => {
  const result = validateCommitmentCorrectionChanges(
    [change({ field: "priority", proposed_value: "urgent" })],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, false);
});

test("validate: a status correction ('finished' -> completed, mapped by the agent, validated here)", () => {
  const result = validateCommitmentCorrectionChanges(
    [change({ field: "status", current_value: "pending", proposed_value: "completed" })],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.patch, { status: "completed" });
});

test("validate: an invalid status value is rejected", () => {
  const result = validateCommitmentCorrectionChanges([change({ field: "status", proposed_value: "archived" })], {
    commitment: commitment(),
    participantOptions: PARTICIPANTS
  });
  assert.equal(result.ok, false);
});

// ============================================================
// 7. multiple fields in one request -> one combined, atomic patch
// ============================================================

test("validate: multiple changes in one proposal combine into a single patch object (one atomic UPDATE, no per-field request)", () => {
  const result = validateCommitmentCorrectionChanges(
    [
      change({ field: "owner", proposed_value: "Aditya Ujawane" }),
      change({ field: "due_date", proposed_value: "2026-08-20" }),
      change({ field: "priority", proposed_value: "high" })
    ],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.patch, {
    lead_owner_name: "Aditya Ujawane",
    due_date: "2026-08-20",
    priority: "high"
  });
  assert.equal(result.summaries.length, 3);
});

// ============================================================
// 8. ambiguous person -> clarification, no proposal (prompt-level instruction + schema shape)
// ============================================================

test("agent prompt: instructs asking a clarifying question rather than guessing when a person mention is ambiguous", async () => {
  const source = await readFile(new URL("../lib/commitment-correction/agent.ts", import.meta.url), "utf8");
  assert.match(source, /matches more than one participant/);
  assert.match(source, /responseType='clarification'/);
  assert.match(source, /Do not guess|do not guess|ask a clarifying question/i);
});

test("clarification/answer responses carry no changes -- the schema allows an empty changes array so the UI never shows a proposal for an unresolved request", () => {
  const parsed = commitmentCorrectionResponseSchema.safeParse({
    responseType: "clarification",
    message: "I found two people named Craig: Craig Lauer and Craig Smith. Which one should I use?",
    changes: []
  });
  assert.equal(parsed.success, true);
});

// ============================================================
// 9/12. unsupported field / server allowlist enforced
// ============================================================

test("schema: the correctable field allowlist excludes classification/completion_state/acceptance criteria and any raw DB column name", () => {
  assert.deepEqual(
    [...CORRECTABLE_COMMITMENT_FIELDS].sort(),
    ["description", "due_date", "owner", "priority", "status", "supporting_person", "title"].sort()
  );
  assert.ok(!CORRECTABLE_COMMITMENT_FIELDS.includes("execution_classification" as never));
  assert.ok(!CORRECTABLE_COMMITMENT_FIELDS.includes("completion_state" as never));
  assert.ok(!CORRECTABLE_COMMITMENT_FIELDS.includes("meeting_id" as never));
  assert.ok(!CORRECTABLE_COMMITMENT_FIELDS.includes("id" as never));
});

test("schema: an unsupported field value is rejected at parse time -- the model cannot express it even if it tried", () => {
  const parsed = commitmentCorrectionChangeSchema.safeParse({
    field: "meeting_id",
    current_value: null,
    proposed_value: "some-other-meeting",
    supporting_person_from: null,
    confidence: 0.9
  });
  assert.equal(parsed.success, false);
});

test("schema: unknown/extra keys on a change are rejected (.strict()) -- no table/column/RPC name can ever ride along", () => {
  const parsed = commitmentCorrectionChangeSchema.safeParse({
    field: "title",
    current_value: null,
    proposed_value: "New title",
    supporting_person_from: null,
    confidence: 0.9,
    sql: "UPDATE meeting_commitments SET title = 'x'"
  });
  assert.equal(parsed.success, false);
});

// ============================================================
// 10. no-op change rejected
// ============================================================

test("validate: a change back to the exact current value is a no-op and contributes nothing to the patch", () => {
  const result = validateCommitmentCorrectionChanges(
    [change({ field: "priority", current_value: "medium", proposed_value: "medium" })],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, false);
});

test("validate: a mixed batch (one real change, one no-op) applies only the real change rather than rejecting everything", () => {
  const result = validateCommitmentCorrectionChanges(
    [
      change({ field: "priority", current_value: "medium", proposed_value: "medium" }),
      change({ field: "due_date", proposed_value: "2026-08-20" })
    ],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.patch, { due_date: "2026-08-20" });
});

test("validate: owner reselected to the same person (case/whitespace-insensitive) is a no-op", () => {
  const result = validateCommitmentCorrectionChanges(
    [change({ field: "owner", proposed_value: "francesca todarello" })],
    { commitment: commitment(), participantOptions: PARTICIPANTS }
  );
  assert.equal(result.ok, false);
});

// ============================================================
// 11. malformed model output rejected
// ============================================================

test("schema: a response missing required fields fails validation", () => {
  const parsed = commitmentCorrectionResponseSchema.safeParse({ responseType: "proposal" });
  assert.equal(parsed.success, false);
});

test("schema: confidence outside [0,1] is rejected", () => {
  const parsed = commitmentCorrectionChangeSchema.safeParse({
    field: "priority",
    current_value: "medium",
    proposed_value: "high",
    supporting_person_from: null,
    confidence: 1.5
  });
  assert.equal(parsed.success, false);
});

test("agent: malformed/unparseable model output is turned into a graceful fallback answer by the messages route, not a hard crash", async () => {
  const source = await readFile(
    new URL("../app/api/commitments/[id]/correction/messages/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /if \(!agentResult\.ok\) \{/);
  assert.match(source, /Sorry, I couldn't understand that/);
});

// ============================================================
// 13/14. applied correction uses the canonical update path; manual overrides/reanalysis preserved
// ============================================================

test("commitment-mutations: preserve_on_reanalysis and manual_override_fields are set on every applied patch, same as every other Phase 6 correction", async () => {
  const source = await readFile(new URL("../lib/commitment-mutations.ts", import.meta.url), "utf8");
  assert.match(source, /preserve_on_reanalysis: true/);
  assert.match(source, /mergeManualOverrideFields\(/);
  assert.match(source, /Object\.keys\(update\)/);
});

test("apply route: uses lib/commitment-mutations.ts's applyCommitmentPatch, the exact same write path as the general commitment PATCH route -- no second, hand-copied update", async () => {
  const applyRoute = await readFile(
    new URL("../app/api/commitments/[id]/correction/apply/route.ts", import.meta.url),
    "utf8"
  );
  const patchRoute = await readFile(new URL("../app/api/commitments/[id]/route.ts", import.meta.url), "utf8");
  assert.match(applyRoute, /import \{ applyCommitmentPatch \} from "@\/lib\/commitment-mutations";/);
  assert.match(applyRoute, /await applyCommitmentPatch\(commitment\.id, validated\.patch\)/);
  assert.match(patchRoute, /import \{ applyCommitmentPatch \} from "@\/lib\/commitment-mutations";/);
  assert.doesNotMatch(applyRoute, /\.from\("meeting_commitments"\)\s*\.update\(/);
});

test("apply route: re-validates against fresh server-loaded commitment/participant state, never trusting the client-echoed proposal", async () => {
  const source = await readFile(
    new URL("../app/api/commitments/[id]/correction/apply/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /getOwnedCommitment\(id, auth\.user\.id\)/);
  assert.match(source, /loadMeetingParticipantOptions\(commitment\.meeting_id\)/);
  assert.match(source, /validateCommitmentCorrectionChanges\(parsed\.data\.changes, \{/);
});

// ============================================================
// 15. correction audit/report stored
// ============================================================

test("apply route: records an audit entry on the commitment's existing comment thread, reusing commitment_comments (not a new table)", async () => {
  const source = await readFile(
    new URL("../app/api/commitments/[id]/correction/apply/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /supabaseAdmin\.from\("commitment_comments"\)\.insert\(\{/);
  assert.match(source, /role: "system"/);
  assert.match(source, /kind: "ai_correction"/);
  assert.match(source, /user_message: parsed\.data\.sourceMessage/);
  assert.match(source, /changes: validated\.summaries/);
});

// ============================================================
// 16. failed mutation does not falsely report success
// ============================================================

test("apply route: a validation failure returns an error status, never a 200 with a fabricated commitment", async () => {
  const source = await readFile(
    new URL("../app/api/commitments/[id]/correction/apply/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /if \(!validated\.ok\) \{\s*return NextResponse\.json\(\{ error: validated\.error \}, \{ status: 400 \}\);/);
  assert.match(source, /if \("error" in result\) \{/);
});

test("entity correction assistant: an apply failure preserves the pending proposal and shows the error rather than clearing state as if it succeeded", async () => {
  const source = await readFile(new URL("../components/entity-correction-assistant.tsx", import.meta.url), "utf8");
  const applyFn = source.slice(
    source.indexOf("async function applyProposal()"),
    source.indexOf("function handleSubmit")
  );
  const failureBranch = applyFn.slice(
    applyFn.indexOf("if (!response.ok"),
    applyFn.indexOf("onApplied(result.commitment);")
  );
  assert.match(failureBranch, /setError\(result\.error \|\| "Failed to apply the correction\."\);/);
  assert.match(failureBranch, /return;/);
  assert.doesNotMatch(failureBranch, /setPendingProposal\(null\)/);
});

// ============================================================
// 17. chat follow-up replaces the outdated pending proposal, never stacks
// ============================================================

test("entity correction assistant: each new agent turn replaces pendingProposal wholesale -- never stacks/merges with the previous one", async () => {
  const source = await readFile(new URL("../components/entity-correction-assistant.tsx", import.meta.url), "utf8");
  const setPendingProposalCalls = source.match(/setPendingProposal\([^;]*\);/g) ?? [];
  // Exactly two call sites: (1) after every chat turn, unconditionally replacing state with the
  // new turn's result or null; (2) clearing it to null after a successful apply. Never an
  // updater-function form that appends to a previous array.
  assert.equal(setPendingProposalCalls.length, 2);
  for (const call of setPendingProposalCalls) {
    assert.doesNotMatch(call, /\(current\)/);
  }
});

test("agent prompt: instructs replacing a previously proposed field rather than adding a conflicting second entry on follow-up refinement", async () => {
  const source = await readFile(new URL("../lib/commitment-correction/agent.ts", import.meta.url), "utf8");
  assert.match(source, /replace that field's proposed_value with the/);
  assert.match(source, /do not add a second, conflicting entry/);
});

// ============================================================
// 19. unauthorized entity rejected
// ============================================================

test("both correction routes reject a commitment the caller does not own before doing anything else", async () => {
  for (const file of [
    "../app/api/commitments/[id]/correction/messages/route.ts",
    "../app/api/commitments/[id]/correction/apply/route.ts"
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const authIndex = source.indexOf("getOwnedCommitment(id, auth.user.id)");
    const bodyParseIndex = source.indexOf("bodySchema.safeParse");
    assert.ok(authIndex > -1, `${file}: missing ownership check`);
    assert.ok(bodyParseIndex > -1, `${file}: missing body validation`);
    assert.ok(authIndex < bodyParseIndex, `${file}: ownership must be checked before parsing the body`);
    assert.match(source, /Commitment not found/);
  }
});

// ============================================================
// Context construction: single-entity, no transcript, participant options included per section 25
// ============================================================

test("buildCommitmentCorrectionContext: compact context includes editable-field state, supporting people, and participant options -- no transcript/topics/insights", () => {
  const context = buildCommitmentCorrectionContext({
    commitment: commitment(),
    sourceMeeting: { id: "meeting-1", title: "Bloom Base kickoff" },
    participantOptions: PARTICIPANTS
  });
  assert.equal(context.commitment.owner, "Francesca Todarello");
  assert.deepEqual(context.commitment.supporting_people, ["Aditya Ujawane"]);
  assert.equal(context.commitment.due_date, "2026-08-11");
  assert.deepEqual(context.participant_options, PARTICIPANTS);
  assert.equal(context.source_meeting?.title, "Bloom Base kickoff");
  assert.match(context.today, /^\d{4}-\d{2}-\d{2}$/);
});

test("agent: never sends the meeting transcript -- context is limited to the commitment's own fields, participants, and today's date", async () => {
  const source = await readFile(new URL("../lib/commitment-correction/agent.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /transcript/i);
});

// ============================================================
// Do-not-modify guardrails: this feature must not touch Execution Intelligence V4, extraction,
// speaker diarization, AI dependency inference, Meeting Assistant, Project Brain, or deliverables.
// ============================================================

test("no correction-feature file imports from the untouchable systems listed in the PR description", async () => {
  const files = [
    "../lib/commitment-correction/agent.ts",
    "../lib/commitment-correction/context.ts",
    "../lib/commitment-correction/validate.ts",
    "../lib/commitment-mutations.ts",
    "../app/api/commitments/[id]/correction/messages/route.ts",
    "../app/api/commitments/[id]/correction/apply/route.ts",
    "../components/entity-correction-assistant.tsx"
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const importLines = source.match(/^import .*$/gm) ?? [];
    for (const line of importLines) {
      assert.doesNotMatch(line, /project-brain/);
      assert.doesNotMatch(line, /meeting-assistant/);
      assert.doesNotMatch(line, /task-dependency-inference/);
      assert.doesNotMatch(line, /execution-intelligence/);
      assert.doesNotMatch(line, /task-deliverable-lifecycle/);
    }
  }
});

// ============================================================
// Regression: server-side correction modules must never import from a "use client" module (this
// is exactly the bug that caused POST /api/commitments/[id]/correction/messages to 500 --
// isSameOwnerValue was defined in components/task-owner-select.tsx, a "use client" file, and
// lib/commitment-people.ts imported it from there). Pure helpers shared between server and client
// code must live in a plain lib/* module with no "use client" directive.
// ============================================================

test("server-side commitment-correction modules never import anything from components/* (the server/client boundary bug class)", async () => {
  const serverFiles = [
    "../lib/commitment-correction/agent.ts",
    "../lib/commitment-correction/context.ts",
    "../lib/commitment-correction/validate.ts",
    "../lib/commitment-mutations.ts",
    "../lib/commitment-people.ts",
    "../app/api/commitments/[id]/correction/messages/route.ts",
    "../app/api/commitments/[id]/correction/apply/route.ts"
  ];
  for (const file of serverFiles) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const importLines = source.match(/^import .*$/gm) ?? [];
    for (const line of importLines) {
      assert.doesNotMatch(line, /from "@\/components\//, `${file}: "${line}" imports from a client component`);
    }
  }
});

test("lib/owner-utils.ts is a plain server-safe module: no \"use client\" directive, no React, no component imports", async () => {
  const source = await readFile(new URL("../lib/owner-utils.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^"use client";/m);
  assert.doesNotMatch(source, /from "react"/);
  assert.doesNotMatch(source, /from "@\/components\//);
});

test("components/task-owner-select.tsx no longer defines isSameOwnerValue itself -- it stays a pure client-select component, the comparison logic lives in lib/owner-utils.ts", async () => {
  const source = await readFile(new URL("../components/task-owner-select.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /export function isSameOwnerValue/);
});
