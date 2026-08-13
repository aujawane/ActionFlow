import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { meetingAssistantResponseSchema } from "../lib/meeting-assistant/agent";

// ============================================================
// 19. generated-content response parsing (structured output layer, mirrors the convention in
// tests/task-dependency-inference.test.ts's dependencyInferenceResultSchema coverage -- no live
// OpenAI call is made or mocked; this is the same zod schema the agent parses the model's
// response through).
// ============================================================

test("meetingAssistantResponseSchema: parses a well-formed 'answer' response", () => {
  const parsed = meetingAssistantResponseSchema.safeParse({
    responseType: "answer",
    assistantMessage: "Aditya Ujawane owns the Shopify website build.",
    generatedContent: [],
    evidenceSegmentIds: []
  });
  assert.equal(parsed.success, true);
});

test("meetingAssistantResponseSchema: parses a well-formed 'generated_content' response with multiple drafts", () => {
  const parsed = meetingAssistantResponseSchema.safeParse({
    responseType: "generated_content",
    assistantMessage: "Here are individual follow-ups:",
    generatedContent: [
      { title: "Aditya Ujawane", subject: "Your action items", body: "Hi Aditya, ..." },
      { title: "Craig Lauer", subject: "Your action items", body: "Hi Craig, ..." }
    ],
    evidenceSegmentIds: []
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.generatedContent.length, 2);
});

test("meetingAssistantResponseSchema: parses a 'declined_mutation' response", () => {
  const parsed = meetingAssistantResponseSchema.safeParse({
    responseType: "declined_mutation",
    assistantMessage: "I can't change that directly -- use the task's \"...\" menu to reassign it.",
    generatedContent: [],
    evidenceSegmentIds: []
  });
  assert.equal(parsed.success, true);
});

test("meetingAssistantResponseSchema: rejects an unknown responseType", () => {
  const parsed = meetingAssistantResponseSchema.safeParse({
    responseType: "mutate",
    assistantMessage: "x",
    generatedContent: [],
    evidenceSegmentIds: []
  });
  assert.equal(parsed.success, false);
});

test("meetingAssistantResponseSchema: rejects extra/unexpected fields (strict schema)", () => {
  const parsed = meetingAssistantResponseSchema.safeParse({
    responseType: "answer",
    assistantMessage: "x",
    generatedContent: [],
    evidenceSegmentIds: [],
    taskPatch: { owner: "Someone" }
  });
  assert.equal(parsed.success, false);
});

test("meetingAssistantResponseSchema: a generatedContent item requires a non-empty title and body but subject may be null", () => {
  const parsed = meetingAssistantResponseSchema.safeParse({
    responseType: "generated_content",
    assistantMessage: "Here's the agenda:",
    generatedContent: [{ title: "Next Meeting Agenda", subject: null, body: "1. Shopify account setup" }],
    evidenceSegmentIds: []
  });
  assert.equal(parsed.success, true);
});

// ============================================================
// System-prompt-level behavioral contracts (golden-source, same convention used throughout this
// repo for OpenAI-calling modules whose live call can't be exercised in tests -- see
// task-categorization.test equivalents / task-dependency-inference.test.ts).
// ============================================================

test("agent: system prompt instructs that canonical Parfait data overrides old transcript attribution", async () => {
  const source = await readFile(new URL("../lib/meeting-assistant/agent.ts", import.meta.url), "utf8");
  assert.match(source, /Current canonical Parfait state overrides old extracted\/raw transcript attribution/);
});

test("agent: system prompt instructs declining mutations rather than performing them", async () => {
  const source = await readFile(new URL("../lib/meeting-assistant/agent.ts", import.meta.url), "utf8");
  assert.match(source, /do not perform or/);
  assert.match(source, /declined_mutation/);
  assert.match(source, /menu to make the correction/);
});

test("agent: system prompt instructs never inventing an email address", async () => {
  const source = await readFile(new URL("../lib/meeting-assistant/agent.ts", import.meta.url), "utf8");
  assert.match(source, /never invent an email address/);
});

test("agent: system prompt instructs one generatedContent entry per person for individual/per-person requests, matching team-vs-individual email generation", async () => {
  const source = await readFile(new URL("../lib/meeting-assistant/agent.ts", import.meta.url), "utf8");
  assert.match(source, /one generatedContent entry per person/);
});

test("agent: system prompt instructs the 100%-tasks vs explicit-commitment-completion distinction", async () => {
  const source = await readFile(new URL("../lib/meeting-assistant/agent.ts", import.meta.url), "utf8");
  assert.match(source, /does NOT necessarily mean the commitment/);
});

test("agent: system prompt instructs using is_blocked/blocked_by directly rather than guessing dependency relationships", async () => {
  const source = await readFile(new URL("../lib/meeting-assistant/agent.ts", import.meta.url), "utf8");
  assert.match(source, /never guess at a blocking relationship/);
});

test("agent: never invents tasks/commitments/owners/dates/decisions/quotes", async () => {
  const source = await readFile(new URL("../lib/meeting-assistant/agent.ts", import.meta.url), "utf8");
  assert.match(source, /Never invent tasks, commitments, owners, dates, decisions, or quotes/);
});

test("agent: evidence ids are resolved server-side against segments actually supplied, never trusted directly from the model", async () => {
  const source = await readFile(new URL("../lib/meeting-assistant/agent.ts", import.meta.url), "utf8");
  assert.match(source, /segmentById\.get\(id\)/);
  assert.match(source, /never trusted/);
});

// ============================================================
// 18 & 20. missing transcript / unanalyzed meeting handled gracefully; chat scoped to meeting;
// unauthorized meeting rejected.
// ============================================================

test("route: rejects a meeting the caller does not own before doing anything else", async () => {
  const source = await readFile(
    new URL("../app/api/meetings/[id]/assistant/messages/route.ts", import.meta.url),
    "utf8"
  );
  // Ownership check happens in both GET and POST, before any comment is read or written.
  const getMatch = source.match(/export async function GET[\s\S]*?export async function POST/);
  assert.ok(getMatch);
  assert.match(getMatch![0], /getOwnedMeeting\(id, auth\.user\.id\)/);
  assert.match(getMatch![0], /Meeting not found/);
});

test("route: every query is scoped by meeting_id -- one meeting's conversation can never read another's", async () => {
  const source = await readFile(
    new URL("../app/api/meetings/[id]/assistant/messages/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /\.eq\("meeting_id", meetingId\)/);
  assert.doesNotMatch(source, /\.from\("task_comments"\)/);
  assert.doesNotMatch(source, /\.from\("commitment_comments"\)/);
});

test("route: computes hasTranscript/meetingAnalyzed flags and passes them to the agent rather than assuming either exists", async () => {
  const source = await readFile(
    new URL("../app/api/meetings/[id]/assistant/messages/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /meetingAnalyzed/);
  assert.match(source, /hasTranscript/);
});

test("route: transcript retrieval only runs when routing decides it's needed AND a transcript exists -- never unconditionally", async () => {
  const source = await readFile(
    new URL("../app/api/meetings/[id]/assistant/messages/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /if \(hasTranscript && shouldIncludeTranscriptEvidence\(userMessage\)\)/);
});

test("route: opening the panel (GET) never calls OpenAI -- only POST does", async () => {
  const source = await readFile(
    new URL("../app/api/meetings/[id]/assistant/messages/route.ts", import.meta.url),
    "utf8"
  );
  const getBody = source.slice(source.indexOf("export async function GET"), source.indexOf("export async function POST"));
  assert.doesNotMatch(getBody, /runMeetingAssistantAgent/);
});

// ============================================================
// Migration / persistence model
// ============================================================

test("migration: meeting_comments is scoped to meeting_id with owner-only RLS, mirroring commitment_comments/task_comments", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/20260817090000_add_meeting_comments.sql", import.meta.url),
    "utf8"
  );
  assert.match(migration, /create table if not exists public\.meeting_comments/);
  assert.match(migration, /meeting_id uuid not null references public\.meetings/);
  assert.match(migration, /role text not null check \(role in \('user', 'assistant', 'system'\)\)/);
  assert.match(migration, /alter table public\.meeting_comments enable row level security/);
  assert.match(migration, /meeting\.user_id = auth\.uid\(\)/);
});

// ============================================================
// UI wiring: no OpenAI call merely to open the drawer; suggestions are precomputed, not fetched.
// ============================================================

test("panel: opening the panel only fetches conversation history (GET), never calls the send endpoint on mount", async () => {
  const source = await readFile(
    new URL("../components/meeting-assistant-panel.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /loadComments/);
  assert.doesNotMatch(source, /useEffect\(\(\) => \{\s*void submitMessage/);
});

test("meeting detail page: suggestion chips are computed from already-loaded data, no fetch/OpenAI call involved", async () => {
  const source = await readFile(new URL("../app/meetings/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(source, /assistantSuggestions/);
  assert.match(source, /<MeetingAssistantPanel/);
});

// ============================================================
// Layout: persistent xl+ rail vs. below-xl trigger/drawer fallback. Presentation-only --
// asserted the same way as everything else in this file (golden-source pattern), since there's
// no DOM test harness in this repo (see the file-level comment at the top for that convention).
// ============================================================

test("panel: renders exactly one MeetingAssistantPanel component -- single conversation state, no separate desktop/mobile implementations", async () => {
  const source = await readFile(
    new URL("../components/meeting-assistant-panel.tsx", import.meta.url),
    "utf8"
  );
  // Exactly one component export, and exactly one comments state slice -- if a second, parallel
  // implementation were added for the rail vs. the drawer, this would need two of each.
  assert.equal((source.match(/export function MeetingAssistantPanel/g) ?? []).length, 1);
  assert.equal((source.match(/useState<MeetingComment\[\] \| null>/g) ?? []).length, 1);
});

test("panel: the persistent rail is unconditionally visible at the xl breakpoint regardless of the open/closed toggle", async () => {
  const source = await readFile(
    new URL("../components/meeting-assistant-panel.tsx", import.meta.url),
    "utf8"
  );
  // xl:block overrides the mobile/laptop `hidden` state; the ternary that drives visibility below
  // xl is entirely separate from these xl: classes.
  assert.match(source, /xl:static xl:z-auto xl:block/);
});

test("panel: the rail is sticky and height-capped at xl+ so it scrolls independently of the page", async () => {
  const source = await readFile(
    new URL("../components/meeting-assistant-panel.tsx", import.meta.url),
    "utf8"
  );
  assert.match(source, /xl:sticky xl:top-20/);
  assert.match(source, /xl:max-h-\[calc\(100vh-6rem\)\]/);
});

test("panel: the compact trigger button is hidden at xl+ (only the persistent rail is used there)", async () => {
  const source = await readFile(
    new URL("../components/meeting-assistant-panel.tsx", import.meta.url),
    "utf8"
  );
  const triggerButtonMatch = source.match(/onClick=\{\(\) => setOpen\(true\)\}[\s\S]{0,120}/);
  assert.ok(triggerButtonMatch);
  assert.match(triggerButtonMatch![0], /xl:hidden/);
});

test("panel: conversation history is loaded unconditionally on mount, not gated behind the open/closed toggle", async () => {
  const source = await readFile(
    new URL("../components/meeting-assistant-panel.tsx", import.meta.url),
    "utf8"
  );
  // The persistent xl+ rail has no "open" action to gate a load-on-open effect behind -- history
  // must load as soon as the component mounts, regardless of breakpoint.
  assert.match(source, /useEffect\(\(\) => \{\s*void loadComments\(\);\s*\}, \[loadComments\]\);/);
});

test("meeting detail page: the utility row no longer renders MeetingAssistantPanel -- it moved into the two-column workspace grid", async () => {
  const source = await readFile(new URL("../app/meetings/[id]/page.tsx", import.meta.url), "utf8");
  const actionsIndex = source.indexOf("<MeetingActions");
  const statusIndex = source.indexOf("<MeetingAnalysisStatusPanel");
  const gridIndex = source.indexOf("xl:grid-cols-[minmax(0,1fr)_400px]");
  const assistantIndex = source.indexOf("<MeetingAssistantPanel");
  assert.ok(actionsIndex > -1 && statusIndex > -1 && gridIndex > -1 && assistantIndex > -1);
  // MeetingActions/MeetingAnalysisStatusPanel render before the two-column grid starts (the
  // utility row); MeetingAssistantPanel is rendered exactly once, and only after that grid opens.
  assert.ok(actionsIndex < gridIndex);
  assert.ok(statusIndex < gridIndex);
  assert.ok(assistantIndex > gridIndex);
  assert.equal((source.match(/<MeetingAssistantPanel/g) ?? []).length, 1);
});

test("meeting detail page: main execution content and MeetingAssistantPanel are grid siblings with an xl+ two-column template", async () => {
  const source = await readFile(new URL("../app/meetings/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(source, /xl:grid-cols-\[minmax\(0,1fr\)_400px\]/);
  assert.match(source, /xl:min-w-0/);
});
