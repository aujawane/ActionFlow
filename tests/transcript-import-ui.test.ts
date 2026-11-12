import "./fixtures/react-global";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AddMeetingModeNav,
  FileDropZone,
  formatLabel,
  formatOffset,
  ImportNotice,
  MissingDateWarning,
  PASTE_PLACEHOLDER,
  PasteEditor,
  PreviewPanel,
  ResumeNotice,
  SourceTabs
} from "../components/import-transcript-parts";
import { canEditMeetingUrl } from "../lib/meeting-details";
import { getMeetingSource, importedMeetingLabel, isRecallMeeting } from "../lib/meeting-source";
import { isSyncStatusRecoverable } from "../lib/recall/webhook-events";
import type { TranscriptImportPreview } from "../lib/transcript-import/prepare";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

const PREVIEW: TranscriptImportPreview = {
  source: "manual_paste",
  format: "speaker_labeled",
  container: "text",
  segmentCount: 16,
  turnCount: 16,
  characterCount: 1500,
  speakers: [{ label: "Alex", segmentCount: 8 }, { label: "Jordan", segmentCount: 8 }],
  hasSpeakers: true,
  hasTimeOffsets: false,
  hasAbsoluteTimestamps: false,
  warnings: [
    { code: "uncertain_speaker_labels", message: "Some speaker names appear only once and may not be speakers." },
    { code: "meeting_date_missing", message: "No meeting date was given." }
  ],
  sampleSegments: [
    { index: 0, speaker: "Alex", text: "I'll send the requirements by Friday.", startOffsetMs: null },
    { index: 1, speaker: "Jordan", text: "I'll review them by Monday.", startOffsetMs: 75_000 },
    { index: 14, speaker: "Alex", text: "So to recap.", startOffsetMs: null },
    { index: 15, speaker: "Unknown Speaker", text: "Talk soon.", startOffsetMs: null }
  ]
};

// ------------------------------------------------------------------ entry point
test("Add Meeting offers both ways in, with the import mode linkable directly", () => {
  const bot = html(h(AddMeetingModeNav, { mode: "bot" }));
  assert.match(bot, /<nav[^>]*aria-label="How to add a meeting"/);
  assert.match(bot, /Send Parfait bot/);
  assert.match(bot, /Import transcript/);
  assert.match(bot, /href="\/meetings\/new"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/meetings\/new"/);
  assert.match(bot, /href="\/meetings\/new\?mode=import"/);
  const imp = html(h(AddMeetingModeNav, { mode: "import" }));
  const importLink = imp.match(/<a[^>]*href="\/meetings\/new\?mode=import"[^>]*>/)?.[0] ?? "";
  assert.match(importLink, /aria-current="page"/);
  assert.equal((imp.match(/aria-current="page"/g) ?? []).length, 1);
});

test("the page reads ?mode=import, lists only the user's own projects, and keeps the bot form for everything else", async () => {
  const page = await read("app/meetings/new/page.tsx");
  assert.match(page, /params\.mode === "import"/);
  assert.match(page, /\.eq\("owner_id", user\.id\)/);
  assert.match(page, /importing \? <ImportTranscriptForm projects=\{projects\} \/> : <NewMeetingForm \/>/);
  assert.match(page, /requireUser\(\)/);
});

test("the existing bot flow is untouched", async () => {
  const form = await read("components/new-meeting-form.tsx");
  assert.match(form, /fetch\("\/api\/meetings", \{/);
  assert.match(form, /Send Parfait Bot/);
  assert.match(form, /supportedMeetingUrl|validateNewMeetingInput/);
  assert.doesNotMatch(form, /import-transcript|ImportSession|transcript import/i);
  const route = await read("app/api/meetings/route.ts");
  assert.match(route, /createRecallBot/);
  assert.doesNotMatch(route, /manual_(upload|paste)/);
});

// ------------------------------------------------------------------ upload and paste
test("upload and paste are an accessible tab pair", () => {
  const upload = html(h(SourceTabs, { mode: "upload" }));
  assert.match(upload, /role="tablist"[^>]*aria-label="Transcript source"/);
  assert.equal((upload.match(/role="tab"/g) ?? []).length, 2);
  assert.match(upload, /Upload file/);
  assert.match(upload, /Paste transcript/);
  const selected = upload.match(/<button[^>]*aria-selected="true"[^>]*>/)?.[0] ?? "";
  assert.match(selected, /id="import-tab-upload"/);
  assert.match(selected, /aria-controls="import-panel-upload"/);
  assert.match(selected, /tabindex="0"/);
  assert.match(upload.match(/<button[^>]*aria-selected="false"[^>]*>/)?.[0] ?? "", /tabindex="-1"/);
  const paste = html(h(SourceTabs, { mode: "paste" })).match(/<button[^>]*aria-selected="true"[^>]*>/)?.[0] ?? "";
  assert.match(paste, /id="import-tab-paste"/);
});

test("the file area names every supported type, the size limit, and what is not supported", () => {
  const markup = html(h(FileDropZone, { file: null }));
  for (const type of [".txt", ".md", ".vtt", ".srt"]) assert.ok(markup.includes(type), type);
  assert.match(markup, /accept="\.txt,\.md,\.vtt,\.srt"/);
  assert.match(markup, /1\.00 MB/);
  assert.match(markup, /PDFs, documents, audio and video aren(&#x27;|’|&rsquo;)t supported/);
  assert.match(markup, /Drag a transcript here, or browse/);
  assert.match(markup, /<label[^>]*for="import-file"/, "the whole area is a label for the file input");
  assert.match(markup, /type="file"[^>]*class="sr-only"|class="sr-only"[^>]*type="file"/, "the input stays focusable for keyboards");
  assert.doesNotMatch(markup, /\.pdf|\.docx|\.mp3|\.mp4/);
});

test("a selected file shows its name and size and can be removed or replaced", () => {
  const markup = html(h(FileDropZone, { file: { name: "Q3 planning.vtt", size: 24_576 } }));
  assert.match(markup, /Q3 planning\.vtt/);
  assert.match(markup, /24\.0 KB/);
  assert.match(markup, /aria-label="Remove Q3 planning\.vtt"/);
  assert.match(markup, /Choose a different file/);
});

test("file errors are announced and tied to the input", () => {
  const markup = html(h(FileDropZone, { file: null, error: "This file is 2.10 MB. Transcripts can be at most 1 MB." }));
  assert.match(markup, /id="import-file-error"[^>]*role="alert"|role="alert"[^>]*id="import-file-error"/);
  assert.match(markup, /aria-invalid="true"/);
  assert.match(markup, /aria-describedby="import-file-error"/);
});

test("paste mode: a labelled editor, a speaker-labelled example, a live character count and empty-state guidance", () => {
  const empty = html(h(PasteEditor, { text: "" }));
  assert.match(empty, /<label[^>]*for="import-text"/);
  assert.match(empty, /<textarea[^>]*id="import-text"/);
  assert.ok(empty.includes("Alex: Thanks for joining"));
  assert.match(PASTE_PLACEHOLDER, /^Alex: .*\nJordan: /);
  assert.match(empty, /0 characters/);
  assert.match(empty, /Paste speaker-labeled dialogue/);
  const filled = html(h(PasteEditor, { text: "Alex: hi there" }));
  assert.match(filled, /14 characters/);
  assert.match(filled, /exactly as pasted/);
  const errored = html(h(PasteEditor, { text: "", error: "Paste the transcript text." }));
  assert.match(errored, /role="alert"/);
});

// ------------------------------------------------------------------ preview
test("the preview shows format, segments, speakers, time information and sample turns", () => {
  const markup = html(h(PreviewPanel, { preview: PREVIEW }));
  assert.match(markup, /Transcript preview/);
  assert.match(markup, />Speaker-labeled</);
  assert.match(markup, />16</);
  assert.match(markup, /Alex, Jordan/);
  assert.match(markup, /Not provided/);
  assert.match(markup, /I&#x27;ll send the requirements by Friday\./);
  assert.match(markup, /1:15/, "offsets are shown as offsets");
  assert.match(markup, /… 12 more segments …/, "the gap between head and tail is stated, not hidden");
  assert.match(markup, /Unknown Speaker/);
  assert.match(markup, /Parfait uses the speaker names found in your transcript/);
  assert.doesNotMatch(markup, /1970/);
});

test("preview warnings are surfaced, and the missing-date warning is shown once, by its own callout", () => {
  const markup = html(h(PreviewPanel, { preview: PREVIEW }));
  assert.match(markup, /Some speaker names appear only once/);
  assert.doesNotMatch(markup, /No meeting date was given/);
  const callout = html(h(MissingDateWarning, { onAddDate: () => undefined }));
  assert.match(callout, /No meeting date/);
  assert.match(callout, /tomorrow/);
  assert.match(callout, /Add the meeting date/);
  const none = html(h(PreviewPanel, { preview: { ...PREVIEW, speakers: [], hasSpeakers: false, warnings: [], hasTimeOffsets: true } }));
  assert.match(none, /None detected/);
  assert.match(none, /Times from the start of the recording/);
});

test("format labels and offsets read naturally", () => {
  assert.equal(formatLabel("webvtt"), "WebVTT subtitles");
  assert.equal(formatLabel("plain_text"), "Plain text");
  assert.equal(formatOffset(133_000), "2:13");
  assert.equal(formatOffset(3_723_000), "1:02:03");
});

// ------------------------------------------------------------------ notices
test("errors and recovery notices are announced, calm for retryable states, and carry actions", () => {
  const retry = html(h(ImportNotice, { error: { kind: "unknown_outcome", code: "network", message: "We couldn't confirm whether the import went through." }, secondsLeft: 7, actions: h("button", null, "Retry import") }));
  assert.match(retry, /role="alert"/);
  assert.match(retry, /data-kind="unknown_outcome"/);
  assert.match(retry, /amber/);
  assert.match(retry, /You can retry in 7 seconds/);
  assert.match(retry, /Retry import/);
  const hard = html(h(ImportNotice, { error: { kind: "input", code: "invalid_utf8", message: "The transcript is not valid UTF-8 text." } }));
  assert.match(hard, /rose/);
  assert.doesNotMatch(hard, /retry in/);
  const resume = html(h(ResumeNotice, { title: "Q3 sync", mode: "upload", fileName: "sync.vtt", startedAtLabel: "Nov 12, 2026" }));
  assert.match(resume, /An import is in progress/);
  assert.match(resume, /Choose the same file again \(sync\.vtt\)/);
  assert.match(resume, /isn(&#x27;|’|&rsquo;)t stored in the browser/);
  assert.match(html(h(ResumeNotice, { title: "t", mode: "paste", fileName: null })), /Paste the same transcript again/);
});

// ------------------------------------------------------------------ the form
test("the form wires preview, confirmation, import and navigation through the session", async () => {
  const form = await read("components/import-transcript-form.tsx");
  // Confirmation gates the action.
  assert.match(form, /id="import-confirm"/);
  assert.match(form, /disabled=\{!canSubmit\}/);
  assert.match(form, /session\.setConfirmed\(event\.target\.checked\)/);
  // One request path, no second parser or network code in the component.
  assert.equal((form.match(/\bfetch\(/g) ?? []).length, 1, "the only fetch is the one handed to the session");
  assert.doesNotMatch(form, /parseTranscriptText|prepareTranscriptImport/);
  // The normal meeting page takes over once the import finished.
  assert.match(form, /state\.phase === "complete" && state\.redirectTo/);
  assert.match(form, /router\.push\(state\.redirectTo as Route\)/);
  // Resume, and no secrets or transcript in browser storage from the component.
  assert.match(form, /session\.restore\(\)/);
  assert.doesNotMatch(form, /localStorage|document\.cookie/);
  // Session expiry offers sign-in; enqueue failure offers the saved meeting.
  assert.match(form, /state\.error\.kind === "session"/);
  assert.match(form, /href=\{"\/login" as Route\}/);
  assert.match(form, /Transcript saved, but analysis didn&rsquo;t start/);
  assert.match(form, /Analyze Meeting/);
  // The date is recommended, never required, and the warning appears before analysis.
  assert.match(form, /Recommended/);
  assert.match(form, /Adding the original meeting date helps Parfait interpret deadlines/);
  assert.match(form, /dateMissing \? <MissingDateWarning/);
  assert.doesNotMatch(form, /id="import-date"[^>]*required/);
  // Retry never asks for a new id; only Start new import does.
  assert.match(form, /session\.startNewImport\(\)/);
  assert.doesNotMatch(form, /randomUUID\(\)[\s\S]*randomUUID\(\)/);
});

test("accessibility and responsive markup: labelled controls, focus styles, no fixed widths", async () => {
  const sources = [await read("components/import-transcript-form.tsx"), await read("components/import-transcript-parts.tsx")].join("\n");
  for (const id of ["import-title", "import-date", "import-project", "import-confirm", "import-file", "import-text"]) {
    assert.match(sources, new RegExp(`htmlFor="${id}"`), `label for ${id}`);
  }
  assert.match(sources, /role="tabpanel"/);
  assert.match(sources, /aria-labelledby=\{`import-tab-\$\{input\.mode\}`\}/);
  assert.match(sources, /onKeyDown/);
  assert.match(sources, /ArrowRight/);
  assert.match(sources, /focus-visible:ring-4/);
  assert.match(sources, /focus-within:ring-4/);
  assert.match(sources, /aria-live="polite"/);
  assert.match(sources, /role="alert"/);
  assert.match(sources, /sm:grid-cols-2/);
  assert.match(sources, /w-full sm:w-auto/);
  assert.match(sources, /truncate/);
  assert.match(sources, /break-words/);
  assert.match(sources, /resize-y/);
  // Nothing is a fixed pixel width that could overflow a 320px screen, and nothing animates beyond
  // the app's own button transitions.
  assert.doesNotMatch(sources, /\b(?:min-)?w-\[\d+(?:px|rem)\]/);
  assert.doesNotMatch(sources, /animate-|transition-all|duration-\d{3,}/);
});

// ------------------------------------------------------------------ source-aware meeting UI
const RECALL = { status: "processing", source: "recall", recall_bot_id: "bot-1", meeting_url: "https://zoom.us/j/1" };
const IMPORTED = { status: "pending", source: "manual_paste", recall_bot_id: null, meeting_url: null };

test("imported meetings are identified by source, never by a missing bot id", () => {
  assert.equal(isRecallMeeting(IMPORTED), false);
  assert.equal(isRecallMeeting({ source: "manual_upload" }), false);
  assert.equal(getMeetingSource({}), "recall", "a row without the column is a Recall meeting");
  // A Recall meeting whose bot creation failed also has no bot id: it must stay a Recall meeting.
  assert.equal(isRecallMeeting({ source: "recall" }), true);
  assert.equal(importedMeetingLabel(IMPORTED), "Imported transcript");
  assert.equal(importedMeetingLabel(RECALL), null);
});

test("Sync Status needs a Recall meeting in flight; the existing status gate is kept as it was", () => {
  const visible = (m: { source?: string | null; status: "pending" | "joining" | "recording" | "processing" | "transcript_ready" | "completed" | "failed" }) =>
    isRecallMeeting({ source: m.source }) && isSyncStatusRecoverable(m.status);
  for (const status of ["joining", "recording", "processing"] as const) {
    assert.equal(visible({ source: "recall", status }), true, status);
    assert.equal(visible({ status }), true, `${status} (no source = recall)`);
    assert.equal(visible({ source: "manual_paste", status }), false);
    assert.equal(visible({ source: "manual_upload", status }), false);
  }
  for (const status of ["pending", "transcript_ready", "completed", "failed"] as const) {
    assert.equal(visible({ source: "recall", status }), false, status);
  }
});

test("the meeting link is editable only for a pending Recall meeting that has no bot yet", () => {
  assert.equal(canEditMeetingUrl({ status: "pending", recall_bot_id: null }), true, "existing behaviour");
  assert.equal(canEditMeetingUrl({ status: "pending", recall_bot_id: null, source: "recall" }), true);
  assert.equal(canEditMeetingUrl({ status: "pending", recall_bot_id: "bot-1", source: "recall" }), false);
  assert.equal(canEditMeetingUrl({ status: "joining", recall_bot_id: null, source: "recall" }), false);
  // A pending import also has no bot id; without the source check it would have been editable.
  assert.equal(canEditMeetingUrl({ status: "pending", recall_bot_id: null, source: "manual_paste" }), false);
  assert.equal(canEditMeetingUrl({ status: "pending", recall_bot_id: null, source: "manual_upload" }), false);
});

test("Recall-only controls are gated by source in the components and the API", async () => {
  const actions = await read("components/meeting-actions.tsx");
  assert.match(actions, /isRecallMeeting\(\{ source \}\) && isSyncStatusRecoverable\(meetingStatus\) \? \(/);
  assert.match(actions, /Analyze Meeting/, "ordinary analysis stays available for imports");
  const editor = await read("components/meeting-details-editor.tsx");
  assert.match(editor, /const recall = isRecallMeeting\(meeting\)/);
  assert.match(editor, /!recall \? null : editing/, "link editing, bot id and technical details are Recall-only");
  assert.match(editor, /importedMeetingLabel\(meeting\)/);
  assert.match(editor, /Meeting date not provided/);
  assert.match(editor, /pollLiveStatus=\{recall\}/);
  const page = await read("app/meetings/[id]/page.tsx");
  assert.match(page, /source=\{meeting\.source\}/);
  assert.match(page, /pollLiveStatus=\{recallMeeting\}/);
  assert.match(page, /This imported transcript could not be processed/);
  assert.match(page, /formatReadableDate\(meeting\.meeting_date \?\? null\)/, "an import is never dated with its import date");
  const transcript = await read("components/live-transcript.tsx");
  assert.match(transcript, /!pollLiveStatus \|\| !ACTIVE_STATUSES\.includes\(meetingStatus\)/);
  const badge = await read("components/live-meeting-status-badge.tsx");
  assert.match(badge, /!pollLiveStatus \|\| !ACTIVE_STATUSES\.includes\(status\)/);
  const library = await read("components/meeting-library.tsx");
  assert.match(library, /importedMeetingLabel\(meeting\) \?\? meetingPlatformLabel\(meeting\.platform\)/);
  assert.match(library, /Import failed\. Open meeting for details\./);
  assert.match(library, /Bot creation failed\. Open meeting for details\./, "the Recall wording is kept");
});

test("Sync Status is refused for imported meetings before Recall is ever contacted", async () => {
  const route = await read("app/api/meetings/[id]/sync-status/route.ts");
  const guard = route.indexOf("isRecallMeeting(meeting)");
  const recallCall = route.indexOf("fetchRecallBotStatus(meeting.recall_bot_id)");
  assert.ok(guard > 0 && recallCall > guard, "the source check comes before any Recall request");
  assert.match(route, /\.select\("id, recall_bot_id, source"\)/);
  assert.match(route, /status: 400/);
});

test("Recall meetings keep every existing control and label", async () => {
  assert.equal(importedMeetingLabel({ source: "recall" }), null);
  const editor = await read("components/meeting-details-editor.tsx");
  assert.match(editor, /meetingPlatformLabel\(meeting\.platform\)/);
  assert.match(editor, /Recall Bot ID/);
  assert.match(editor, /MEETING_URL_LOCKED_MESSAGE/);
  const page = await read("app/meetings/[id]/page.tsx");
  assert.match(page, /Bot creation failed/);
  assert.match(page, /recallMeeting\s*\?\s*formatReadableDate\(getEffectiveMeetingDate\(meeting\)\)/, "Recall dates are unchanged");
});

test("the sign-in redirect keeps the query string so ?mode=import survives login", async () => {
  const middleware = await read("lib/supabase/middleware.ts");
  assert.match(middleware, /searchParams\.set\("next", `\$\{pathname\}\$\{request\.nextUrl\.search\}`\)/);
});
