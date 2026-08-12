import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildMeetingParticipantOptions } from "../lib/meeting-participants";
import {
  ownerSelectValueToOwner,
  resolveTaskOwnerSelectState
} from "../components/task-owner-select";
import type { MeetingSpeakerAlias } from "../lib/types";

function alias(overrides: Partial<MeetingSpeakerAlias>): MeetingSpeakerAlias {
  return {
    id: `alias-${Math.random()}`,
    meeting_id: "meeting-1",
    raw_speaker_label: "Speaker 1",
    display_name: "Someone",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

// ============================================================
// buildMeetingParticipantOptions
// ============================================================

test("buildMeetingParticipantOptions: resolved speaker alias identities are used", () => {
  const options = buildMeetingParticipantOptions({
    aliases: [alias({ raw_speaker_label: "Speaker 1", display_name: "Craig Lauer" })],
    tasks: [],
    commitments: []
  });
  assert.deepEqual(options, ["Craig Lauer"]);
});

test("buildMeetingParticipantOptions: a raw speaker label on a task owner resolves through the meeting's aliases (not shown as a second, unresolved identity)", () => {
  const aliases = [alias({ raw_speaker_label: "Speaker 1", display_name: "Craig Lauer" })];
  const options = buildMeetingParticipantOptions({
    aliases,
    tasks: [{ owner: "Speaker 1" }],
    commitments: []
  });
  assert.deepEqual(options, ["Craig Lauer"]);
});

test("buildMeetingParticipantOptions: task and commitment owners across the meeting are included", () => {
  const options = buildMeetingParticipantOptions({
    aliases: [],
    tasks: [{ owner: "Aditya Ujawane" }, { owner: null }],
    commitments: [{ owner: null, lead_owner_name: "Craig Lauer" }]
  });
  assert.deepEqual(options, ["Aditya Ujawane", "Craig Lauer"]);
});

test("buildMeetingParticipantOptions: a combined/raw label collapses once both named individuals already exist (Project People's existing dedup rule)", () => {
  const options = buildMeetingParticipantOptions({
    aliases: [],
    tasks: [
      { owner: "Craig Lauer" },
      { owner: "Craig Lauer and Laura Wetherhold" },
      { owner: "Laura Wetherhold" }
    ],
    commitments: []
  });
  assert.deepEqual(options, ["Craig Lauer", "Laura Wetherhold"]);
});

test("buildMeetingParticipantOptions: exact-duplicate names across aliases and task owners collapse to one entry", () => {
  const options = buildMeetingParticipantOptions({
    aliases: [alias({ raw_speaker_label: "Speaker 2", display_name: "Aditya Ujawane" })],
    tasks: [{ owner: "aditya ujawane" }],
    commitments: []
  });
  assert.deepEqual(options, ["Aditya Ujawane"]);
});

test("buildMeetingParticipantOptions: owners arrays (plural) on tasks and commitments are also resolved", () => {
  const options = buildMeetingParticipantOptions({
    aliases: [],
    tasks: [{ owner: null, owners: ["Laura Wetherhold"] }],
    commitments: [{ owner: null, owners: ["Craig Lauer"] }]
  });
  assert.deepEqual(options, ["Craig Lauer", "Laura Wetherhold"]);
});

test("buildMeetingParticipantOptions: no participant data at all returns an empty list", () => {
  assert.deepEqual(
    buildMeetingParticipantOptions({ aliases: [], tasks: [], commitments: [] }),
    []
  );
});

// ============================================================
// resolveTaskOwnerSelectState / ownerSelectValueToOwner
// ============================================================

const MEETING_PEOPLE = ["Aditya Ujawane", "Craig Lauer", "Laura Wetherhold"];

test("resolveTaskOwnerSelectState: an unassigned task offers Unassigned plus every meeting participant", () => {
  const state = resolveTaskOwnerSelectState(null, MEETING_PEOPLE);
  assert.equal(state.mode, "select");
  if (state.mode !== "select") return;
  assert.equal(state.selectedValue, "");
  assert.deepEqual(
    state.options.map((option) => option.value),
    ["", "Aditya Ujawane", "Craig Lauer", "Laura Wetherhold"]
  );
  assert.equal(state.options[0].label, "Unassigned");
});

test("resolveTaskOwnerSelectState: an existing owner who is a meeting participant is selected, not duplicated", () => {
  const state = resolveTaskOwnerSelectState("Craig Lauer", MEETING_PEOPLE);
  assert.equal(state.mode, "select");
  if (state.mode !== "select") return;
  assert.equal(state.selectedValue, "Craig Lauer");
  assert.deepEqual(
    state.options.map((option) => option.value),
    ["", "Aditya Ujawane", "Craig Lauer", "Laura Wetherhold"]
  );
});

test("resolveTaskOwnerSelectState: an existing owner not among the meeting's resolved participants is preserved, not silently discarded", () => {
  const state = resolveTaskOwnerSelectState("Didier", MEETING_PEOPLE);
  assert.equal(state.mode, "select");
  if (state.mode !== "select") return;
  assert.equal(state.selectedValue, "Didier");
  assert.deepEqual(
    state.options.map((option) => option.value),
    ["", "Didier", "Aditya Ujawane", "Craig Lauer", "Laura Wetherhold"]
  );
  assert.match(
    state.options.find((option) => option.value === "Didier")!.label,
    /current.*not in this meeting/
  );
});

test("resolveTaskOwnerSelectState: no usable meeting participants and no current owner is a clear disabled empty state, not a broken dropdown", () => {
  const state = resolveTaskOwnerSelectState(null, []);
  assert.deepEqual(state, { mode: "empty" });
});

test("resolveTaskOwnerSelectState: a current owner is still shown even when there are zero resolved meeting participants", () => {
  const state = resolveTaskOwnerSelectState("Didier", []);
  assert.equal(state.mode, "select");
  if (state.mode !== "select") return;
  assert.equal(state.selectedValue, "Didier");
});

test("ownerSelectValueToOwner: selecting a person maps straight to that name", () => {
  assert.equal(ownerSelectValueToOwner("Aditya Ujawane"), "Aditya Ujawane");
});

test("ownerSelectValueToOwner: selecting Unassigned maps to null, never the literal string", () => {
  assert.equal(ownerSelectValueToOwner(""), null);
});

// ============================================================
// UI wiring + canonical update-pathway regression coverage (no DOM/RTL harness in this repo --
// see task-deliverable-lifecycle/project-brain tests for the same convention).
// ============================================================

test("commitment workspace: the per-task owner field is the shared dropdown, not free text", async () => {
  const source = await readFile(
    new URL("../components/commitment-workspace.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /<TaskOwnerSelect\s/);
  assert.match(source, /ownerValue=\{task\.owner\}/);
  assert.match(source, /options=\{meetingParticipantOptions\}/);
  assert.doesNotMatch(source, /placeholder="Unassigned"/);
});

test("task workspace header: the owner field is the shared dropdown, not free text", async () => {
  const source = await readFile(
    new URL("../components/task-workspace-task-state.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /<TaskOwnerSelect\s/);
  assert.match(source, /ownerValue=\{task\.owner\}/);
  assert.match(source, /options=\{meetingParticipantOptions\}/);
  assert.doesNotMatch(source, /placeholder="Unassigned"/);
});

test("owner selection reuses the existing, unmodified task-owner update route -- same authorization and preservation guarantees apply", async () => {
  const routeSource = await readFile(
    new URL("../app/api/tasks/[id]/route.ts", import.meta.url),
    "utf8"
  );
  // Authorization: the route still resolves ownership through the shared chain before any write.
  assert.match(routeSource, /getOwnedTask\(id, auth\.user\.id\)/);
  assert.match(routeSource, /Task not found/);
  // Preservation: an owner change still marks the field manually overridden and reanalysis-safe,
  // exactly as every other Phase 6 correction does.
  assert.match(routeSource, /preserve_on_reanalysis: true/);
  assert.match(routeSource, /mergeManualOverrideFields/);
  // owner remains nullable in the schema (the dropdown's Unassigned option depends on this).
  assert.match(routeSource, /owner: z\.string\(\)\.trim\(\)\.max\(160\)\.nullable\(\)\.optional\(\)/);
});

// ============================================================
// Standalone Tasks (Meeting Detail) follow-up
// ============================================================

test("standalone tasks panel: an unassigned standalone task ('Tag Ticket'-style) gets the shared owner dropdown, not read-only text", async () => {
  const source = await readFile(
    new URL("../components/standalone-tasks-panel.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /<TaskOwnerSelect\s/);
  assert.match(source, /ownerValue=\{task\.owner\}/);
  assert.match(source, /options=\{meetingParticipantOptions\}/);
  // The old read-only rendering must be gone, not just supplemented.
  assert.doesNotMatch(source, /\{task\.owner \|\| "Unassigned"\}/);
});

test("standalone tasks panel: selecting an owner routes through the same canonical PATCH /api/tasks/[id] pathway, and a change confined to `owner` cannot itself demote the task out of Standalone (only commitment_id/execution_classification changes do that)", async () => {
  const source = await readFile(
    new URL("../components/standalone-tasks-panel.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /fetch\(`\/api\/tasks\/\$\{taskId\}`, \{\s*method: "PATCH"/);
  assert.match(source, /body: JSON\.stringify\(\{ owner \}\)/);
  assert.match(source, /handleTaskUpdated\(result\.task as MeetingTask\)/);
});

test("meeting detail page: one meeting-participant option list is computed from already-loaded data and threaded to Standalone Tasks -- no per-task query, no duplicate DB round trip", async () => {
  const source = await readFile(
    new URL("../app/meetings/[id]/page.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /const meetingParticipantOptions = buildMeetingParticipantOptions\(\{/);
  assert.match(
    source,
    /<StandaloneTasksPanel[\s\S]{0,120}meetingParticipantOptions=\{meetingParticipantOptions\}/
  );
  // Built in-process from data this page already fetched once for the whole page (aliases,
  // rawTasks, safeCommitments) -- the query-issuing loader is never called here.
  assert.doesNotMatch(source, /loadMeetingParticipantOptions/);
});

test("buildMeetingParticipantOptions: a meeting participant with no speaker alias and no assigned work is not included -- documented limitation, not silently invented identity", () => {
  // Mirrors the audited conclusion: no lightweight, already-persisted "attended but unassigned"
  // participant source exists in this schema (see lib/meeting-participants.ts doc comment).
  const options = buildMeetingParticipantOptions({
    aliases: [alias({ raw_speaker_label: "Speaker 1", display_name: "Craig Lauer" })],
    tasks: [{ owner: "Craig Lauer" }],
    commitments: []
  });
  assert.deepEqual(options, ["Craig Lauer"]);
  assert.ok(!options.includes("Laura Wetherhold"));
});
