import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildMeetingParticipantOptions } from "../lib/meeting-participants";
import {
  ownerSelectValueToOwner,
  resolveTaskOwnerSelectState
} from "../components/task-owner-select";

// ============================================================
// buildMeetingParticipantOptions
// ============================================================

test("buildMeetingParticipantOptions: Recall participant names are used", () => {
  const options = buildMeetingParticipantOptions({
    transcriptSegments: [{ participant_name: "Craig Lauer", speaker: "Speaker 1" }],
    tasks: [],
    commitments: []
  });
  assert.deepEqual(options, ["Craig Lauer"]);
});

test("buildMeetingParticipantOptions: Recall speaker fallback is available without a participant name", () => {
  const options = buildMeetingParticipantOptions({
    transcriptSegments: [{ participant_name: null, speaker: "Craig Lauer" }],
    tasks: [],
    commitments: []
  });
  assert.deepEqual(options, ["Craig Lauer"]);
});

test("buildMeetingParticipantOptions: task and commitment owners across the meeting are included", () => {
  const options = buildMeetingParticipantOptions({
    tasks: [{ owner: "Aditya Ujawane" }, { owner: null }],
    commitments: [{ owner: null, lead_owner_name: "Craig Lauer" }]
  });
  assert.deepEqual(options, ["Aditya Ujawane", "Craig Lauer"]);
});

test("buildMeetingParticipantOptions: a combined/raw label collapses once both named individuals already exist (Project People's existing dedup rule)", () => {
  const options = buildMeetingParticipantOptions({
    tasks: [
      { owner: "Craig Lauer" },
      { owner: "Craig Lauer and Laura Wetherhold" },
      { owner: "Laura Wetherhold" }
    ],
    commitments: []
  });
  assert.deepEqual(options, ["Craig Lauer", "Laura Wetherhold"]);
});

test("buildMeetingParticipantOptions: duplicates across Recall participants and owners collapse case/whitespace-insensitively", () => {
  const options = buildMeetingParticipantOptions({
    transcriptSegments: [{ participant_name: "Aditya   Ujawane", speaker: null }],
    tasks: [{ owner: " aditya ujawane " }],
    commitments: []
  });
  assert.deepEqual(options, ["Aditya Ujawane"]);
});

test("buildMeetingParticipantOptions: owners arrays (plural) on tasks and commitments are also resolved", () => {
  const options = buildMeetingParticipantOptions({
    tasks: [{ owner: null, owners: ["Laura Wetherhold"] }],
    commitments: [{ owner: null, owners: ["Craig Lauer"] }]
  });
  assert.deepEqual(options, ["Craig Lauer", "Laura Wetherhold"]);
});

test("buildMeetingParticipantOptions: commitment supporting people remain available", () => {
  const options = buildMeetingParticipantOptions({
    tasks: [],
    commitments: [],
    commitmentParticipants: [{ participant_name: "Cameron" }]
  });
  assert.deepEqual(options, ["Cameron"]);
});

test("buildMeetingParticipantOptions: no participant data at all returns an empty list", () => {
  assert.deepEqual(
    buildMeetingParticipantOptions({ tasks: [], commitments: [] }),
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

test("meeting detail page: one meeting-participant option list is computed and threaded to Standalone Tasks -- no per-task query", async () => {
  const source = await readFile(
    new URL("../app/meetings/[id]/page.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /const meetingParticipantOptions = buildMeetingParticipantOptions\(\{/);
  assert.match(
    source,
    /<StandaloneTasksPanel[\s\S]{0,120}meetingParticipantOptions=\{meetingParticipantOptions\}/
  );
  // Built once for the whole page from transcript, execution owners, and supporting people --
  // the query-issuing loader is never called per task.
  assert.doesNotMatch(source, /loadMeetingParticipantOptions/);
});

test("buildMeetingParticipantOptions: a Recall participant with no assigned work remains available", () => {
  const options = buildMeetingParticipantOptions({
    transcriptSegments: [{ participant_name: "Laura Wetherhold", speaker: "Speaker 1" }],
    tasks: [],
    commitments: []
  });
  assert.deepEqual(options, ["Laura Wetherhold"]);
});
