import assert from "node:assert/strict";
import test from "node:test";

import {
  hasNewMeetingFormErrors,
  validateNewMeetingInput
} from "../lib/meeting-form-validation";
import { getSupportedMeetingUrlMessage } from "../lib/meeting-platform";

test("rejects an empty or whitespace-only title", () => {
  const empty = validateNewMeetingInput({ title: "", meetingUrl: "https://zoom.us/j/123456789" });
  assert.equal(empty.title, "Meeting title is required.");

  const whitespace = validateNewMeetingInput({
    title: "   ",
    meetingUrl: "https://zoom.us/j/123456789"
  });
  assert.equal(whitespace.title, "Meeting title is required.");
});

test("rejects an empty meeting link with a distinct message from an unsupported one", () => {
  const empty = validateNewMeetingInput({ title: "Weekly Sync", meetingUrl: "" });
  assert.equal(empty.meetingUrl, "Meeting link is required.");

  const unsupported = validateNewMeetingInput({
    title: "Weekly Sync",
    meetingUrl: "https://example.com/not-a-meeting"
  });
  assert.equal(unsupported.meetingUrl, getSupportedMeetingUrlMessage());
});

test("accepts a valid title with a supported Zoom link and auto-detects the provider", () => {
  const result = validateNewMeetingInput({
    title: "Weekly Product Sync",
    meetingUrl: "https://zoom.us/j/123456789"
  });
  assert.deepEqual(result, { title: null, meetingUrl: null });
});

test("accepts a valid title with a supported Google Meet link", () => {
  const result = validateNewMeetingInput({
    title: "Weekly Product Sync",
    meetingUrl: "https://meet.google.com/abc-defg-hij"
  });
  assert.deepEqual(result, { title: null, meetingUrl: null });
});

test("trims surrounding whitespace before validating both fields", () => {
  const result = validateNewMeetingInput({
    title: "  Weekly Product Sync  ",
    meetingUrl: "  https://meet.google.com/abc-defg-hij  "
  });
  assert.deepEqual(result, { title: null, meetingUrl: null });
});

test("hasNewMeetingFormErrors reflects whether either field failed validation", () => {
  assert.equal(hasNewMeetingFormErrors({ title: null, meetingUrl: null }), false);
  assert.equal(hasNewMeetingFormErrors({ title: "Meeting title is required.", meetingUrl: null }), true);
  assert.equal(
    hasNewMeetingFormErrors({ title: null, meetingUrl: "Meeting link is required." }),
    true
  );
});
