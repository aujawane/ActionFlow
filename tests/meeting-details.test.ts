import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canEditMeetingUrl,
  meetingDetailsPatchSchema,
  meetingProjectAssignmentSchema
} from "../lib/meeting-details";

test("meeting details rejects an empty title", () => {
  const result = meetingDetailsPatchSchema.safeParse({ title: "   " });
  assert.equal(result.success, false);
});

test("meeting details accepts and trims a title", () => {
  const result = meetingDetailsPatchSchema.parse({ title: "  Weekly Sync  " });
  assert.deepEqual(result, { title: "Weekly Sync" });
});

test("project assignment accepts an owned-project-shaped id and can be cleared", () => {
  assert.deepEqual(
    meetingProjectAssignmentSchema.parse({
      project_id: "10000000-0000-4000-8000-000000000001"
    }),
    { project_id: "10000000-0000-4000-8000-000000000001" }
  );
  assert.deepEqual(meetingProjectAssignmentSchema.parse({ project_id: null }), {
    project_id: null
  });
});

test("meeting details accepts supported Zoom and Google Meet links", () => {
  assert.equal(
    meetingDetailsPatchSchema.safeParse({ meeting_url: "https://zoom.us/j/123456789" }).success,
    true
  );
  assert.equal(
    meetingDetailsPatchSchema.safeParse({
      meeting_url: "https://meet.google.com/abc-defg-hij"
    }).success,
    true
  );
});

test("meeting details rejects an unsupported meeting link", () => {
  assert.equal(
    meetingDetailsPatchSchema.safeParse({ meeting_url: "https://example.com/meeting" }).success,
    false
  );
});

test("meeting link is editable only while pending with no Recall bot", () => {
  assert.equal(canEditMeetingUrl({ status: "pending", recall_bot_id: null }), true);
  assert.equal(canEditMeetingUrl({ status: "pending", recall_bot_id: "" }), false);
  assert.equal(canEditMeetingUrl({ status: "pending", recall_bot_id: "bot-123" }), false);

  for (const status of [
    "joining",
    "recording",
    "processing",
    "transcript_ready",
    "completed",
    "failed"
  ] as const) {
    assert.equal(canEditMeetingUrl({ status, recall_bot_id: null }), false, status);
  }
});

test("meeting detail patch rejects system-owned and unrelated fields", () => {
  for (const field of [
    "status",
    "recall_bot_id",
    "created_at",
    "execution_graph_generation",
    "transcript"
  ]) {
    assert.equal(
      meetingDetailsPatchSchema.safeParse({ title: "Allowed", [field]: "not allowed" }).success,
      false,
      field
    );
  }
});

test("meeting update routes preserve authentication, ownership, deletion, and project RPC checks", async () => {
  const meetingRoute = await readFile(
    new URL("../app/api/meetings/[id]/route.ts", import.meta.url),
    "utf8"
  );
  const projectRoute = await readFile(
    new URL("../app/api/meetings/[id]/project/route.ts", import.meta.url),
    "utf8"
  );

  for (const source of [meetingRoute, projectRoute]) {
    assert.match(source, /requireApiUser\(\)/);
    assert.match(source, /\.eq\("user_id", auth\.user\.id\)/);
    assert.match(source, /\.is\("deleted_at", null\)/);
  }

  assert.match(meetingRoute, /meetingDetailsPatchSchema\.safeParse/);
  assert.match(meetingRoute, /canEditMeetingUrl\(existingMeeting\)/);
  assert.match(meetingRoute, /\.eq\("status", "pending"\)\.is\("recall_bot_id", null\)/);
  assert.match(meetingRoute, /detectMeetingPlatform/);
  assert.match(projectRoute, /\.eq\("owner_id", auth\.user\.id\)/);
  assert.match(projectRoute, /\.rpc\("assign_meeting_project"/);
  assert.match(projectRoute, /meeting: updatedMeeting/);
});

test("meeting editor is inline, preserves lock behavior, and refreshes server truth", async () => {
  const editor = await readFile(
    new URL("../components/meeting-details-editor.tsx", import.meta.url),
    "utf8"
  );
  assert.match(editor, /\/api\/meetings\/\$\{meeting\.id\}\/project/);
  assert.match(editor, /router\.refresh\(\)/);
  assert.match(editor, /MEETING_URL_LOCKED_MESSAGE/);
  assert.match(editor, /disabled=\{saving \|\| !linkEditable\}/);
  assert.match(editor, /editing \? "border-slate-300 bg-slate-50\/70"/);
  assert.match(editor, /function cancelEditing\(\)/);
  assert.match(editor, /onClick=\{cancelEditing\}/);
  assert.doesNotMatch(editor, /role="dialog"|aria-modal|fixed inset-0|bg-slate-950\/40/);
});
