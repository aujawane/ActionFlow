import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isValidElement } from "react";

import { renderMarkdownText } from "../lib/parfait-response/markdown";
import { parfaitResponseJsonSchema, parseParfaitResponse } from "../lib/parfait-response/schema";

// ============================================================
// Schema: parseParfaitResponse -- the boundary every model response and every legacy-persisted
// metadata.structuredResponse round-trips through. No live OpenAI call is made or mocked here;
// this exercises exactly the same Zod validation the agent runs on JSON.parse(output_text).
// ============================================================

test("parseParfaitResponse: a direct answer with no sections is valid, sections/followUps omitted from the normalized result", () => {
  const result = parseParfaitResponse({
    answer: "Craig owns this.",
    sections: [],
    followUps: []
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.response.answer, "Craig owns this.");
  assert.equal(result.response.sections, undefined);
  assert.equal(result.response.followUps, undefined);
});

test("parseParfaitResponse: answer + evidence, with source metadata preserved", () => {
  const result = parseParfaitResponse({
    answer: "You committed because you and Craig agreed to host the application together.",
    sections: [
      {
        type: "evidence",
        title: "From the meeting",
        content: "Why don't you and I try and hook up Thursday or Friday and try and host this somewhere",
        items: null,
        source: { meetingId: "m1", segmentId: "seg-42", speaker: "Craig", timestamp: "23:41" }
      }
    ],
    followUps: []
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.response.sections?.length, 1);
  const [section] = result.response.sections!;
  assert.equal(section.type, "evidence");
  if (section.type !== "evidence") return;
  assert.equal(section.source?.speaker, "Craig");
  assert.equal(section.source?.segmentId, "seg-42");
});

test("parseParfaitResponse: answer + blocker + next_action, each section independently present", () => {
  const result = parseParfaitResponse({
    answer: "The main blocker is that the hosting platform has not been chosen yet.",
    sections: [
      { type: "blocker", title: null, content: "The hosting platform and exact day still need to be confirmed.", items: null, source: null },
      { type: "next_action", title: null, content: "Choose the hosting platform and confirm the day.", items: null, source: null }
    ],
    followUps: ["Who else is involved?", "Show me the meeting context"]
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.response.sections?.map((section) => section.type),
    ["blocker", "next_action"]
  );
  assert.deepEqual(result.response.followUps, ["Who else is involved?", "Show me the meeting context"]);
});

test("parseParfaitResponse: a list section", () => {
  const result = parseParfaitResponse({
    answer: "Your next priority is deploying the current application.",
    sections: [
      { type: "list", title: null, content: null, items: ["Deploy to Vercel", "Verify Recall", "Verify transcript processing"], source: null }
    ],
    followUps: []
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const [section] = result.response.sections!;
  assert.equal(section.type, "list");
  if (section.type !== "list") return;
  assert.equal(section.items.length, 3);
});

test("parseParfaitResponse: missing optional sections/followUps arrays are still valid (present-but-empty, per the strict-mode JSON schema)", () => {
  const result = parseParfaitResponse({ answer: "Sure, that sounds reasonable.", sections: [], followUps: [] });
  assert.equal(result.ok, true);
});

test("parseParfaitResponse: an invalid section type is rejected", () => {
  const result = parseParfaitResponse({
    answer: "x",
    sections: [{ type: "summary", title: null, content: "not a real section type", items: null, source: null }],
    followUps: []
  });
  assert.equal(result.ok, false);
});

test("parseParfaitResponse: a list section with zero items is rejected (must have at least one)", () => {
  const result = parseParfaitResponse({
    answer: "x",
    sections: [{ type: "list", title: null, content: null, items: [], source: null }],
    followUps: []
  });
  assert.equal(result.ok, false);
});

test("parseParfaitResponse: a non-list section with empty content is rejected", () => {
  const result = parseParfaitResponse({
    answer: "x",
    sections: [{ type: "blocker", title: null, content: "", items: null, source: null }],
    followUps: []
  });
  assert.equal(result.ok, false);
});

test("parseParfaitResponse: source metadata on a non-evidence section is rejected -- only evidence may cite a source", () => {
  const result = parseParfaitResponse({
    answer: "x",
    sections: [
      {
        type: "blocker",
        title: null,
        content: "still blocked",
        items: null,
        source: { meetingId: "m1", segmentId: null, speaker: null, timestamp: null }
      }
    ],
    followUps: []
  });
  assert.equal(result.ok, false);
});

test("parseParfaitResponse: unknown top-level or section keys are rejected (.strict()) -- no presentation instructions can ride along", () => {
  const result = parseParfaitResponse({
    answer: "x",
    sections: [],
    followUps: [],
    htmlColor: "#ff0000"
  });
  assert.equal(result.ok, false);
});

test("parseParfaitResponse: malformed top-level shape (missing answer) is rejected, not thrown", () => {
  assert.doesNotThrow(() => parseParfaitResponse({ sections: [], followUps: [] }));
  const result = parseParfaitResponse({ sections: [], followUps: [] });
  assert.equal(result.ok, false);
});

test("parseParfaitResponse: completely malformed input (a string, not an object) is rejected gracefully", () => {
  const result = parseParfaitResponse("not an object at all");
  assert.equal(result.ok, false);
});

test("parfaitResponseJsonSchema: every property OpenAI strict mode requires is listed in `required` (nullable, not omittable)", () => {
  const schema = parfaitResponseJsonSchema as {
    required: string[];
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.sort(), ["answer", "followUps", "sections"]);
});

// ============================================================
// Markdown fallback renderer -- real executable coverage of the React element tree, without a
// DOM/RTL harness (none exists in this repo -- see task-owner-select.test.ts's own note on this
// convention). `renderMarkdownText` returns plain React elements (React.createElement output),
// inspectable via react's own isValidElement/props without ever mounting to a DOM.
// ============================================================

function flattenText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: unknown };
    return flattenText(props.children);
  }
  return "";
}

test("renderMarkdownText: **bold** becomes a <strong> element, never literal asterisks", () => {
  const blocks = renderMarkdownText("This is **important**.") as unknown[];
  const paragraph = blocks[0] as { props: { children: unknown[] } };
  const strongNode = paragraph.props.children.find(
    (child) => isValidElement(child) && child.type === "strong"
  );
  assert.ok(strongNode, "expected a <strong> element");
  assert.equal(flattenText(strongNode), "important");
  assert.doesNotMatch(flattenText(paragraph), /\*\*/);
});

test("renderMarkdownText: a blockquote ('> ...') becomes a <blockquote> element, never a literal '>' character", () => {
  const blocks = renderMarkdownText('> Why don\'t you and I try and hook up Thursday') as unknown[];
  const [quote] = blocks as [{ type: string }];
  assert.equal(quote.type, "blockquote");
  assert.doesNotMatch(flattenText(quote), /^>/);
});

test("renderMarkdownText: a '- ' list becomes a <ul> with one <li> per item", () => {
  const blocks = renderMarkdownText("- Deploy to Vercel\n- Verify Recall\n- Verify transcript processing") as unknown[];
  const [list] = blocks as [{ type: string; props: { children: unknown[] } }];
  assert.equal(list.type, "ul");
  assert.equal(list.props.children.length, 3);
  assert.equal(flattenText(list.props.children[0]), "Deploy to Vercel");
});

test("renderMarkdownText: a '1. ' list becomes an <ol>", () => {
  const blocks = renderMarkdownText("1. First\n2. Second") as unknown[];
  const [list] = blocks as [{ type: string }];
  assert.equal(list.type, "ol");
});

test("renderMarkdownText: inline `code` becomes a <code> element", () => {
  const blocks = renderMarkdownText("Run `npm test` to verify.") as unknown[];
  const paragraph = blocks[0] as { props: { children: unknown[] } };
  const codeNode = paragraph.props.children.find((child) => isValidElement(child) && child.type === "code");
  assert.ok(codeNode);
  assert.equal(flattenText(codeNode), "npm test");
});

test("renderMarkdownText: a markdown link becomes an <a> with target=_blank, a javascript: URL is stripped to plain text", () => {
  const safe = renderMarkdownText("See [the docs](https://example.com/docs) for more.") as unknown[];
  const safeParagraph = safe[0] as { props: { children: unknown[] } };
  const link = safeParagraph.props.children.find((child) => isValidElement(child) && child.type === "a") as {
    props: { href: string; target: string };
  };
  assert.equal(link.props.href, "https://example.com/docs");
  assert.equal(link.props.target, "_blank");

  const unsafe = renderMarkdownText("Click [here](javascript:alert(1)) now.") as unknown[];
  const unsafeParagraph = unsafe[0] as { props: { children: unknown[] } };
  const hasAnchor = unsafeParagraph.props.children.some((child) => isValidElement(child) && child.type === "a");
  assert.equal(hasAnchor, false);
  assert.match(flattenText(unsafeParagraph), /here/);
});

test("renderMarkdownText: plain paragraphs with no markdown syntax render as-is", () => {
  const blocks = renderMarkdownText("Craig owns this.") as unknown[];
  assert.equal(blocks.length, 1);
  assert.equal(flattenText(blocks[0]), "Craig owns this.");
});

// ============================================================
// Renderer component: source-level structural checks (no DOM/RTL harness in this repo).
// ============================================================

test("ParfaitResponseRenderer: never uses dangerouslySetInnerHTML anywhere -- structured and legacy paths both build real React elements", async () => {
  const rendererSource = await readFile(
    new URL("../components/parfait-response-renderer.tsx", import.meta.url),
    "utf8"
  );
  const markdownSource = await readFile(new URL("../lib/parfait-response/markdown.tsx", import.meta.url), "utf8");
  // Actual usage would look like `dangerouslySetInnerHTML={...}` or `dangerouslySetInnerHTML:` --
  // both files mention the word in their own doc comments explaining that they avoid it, so match
  // on real JSX/object usage syntax, not just the word appearing anywhere.
  assert.doesNotMatch(rendererSource, /dangerouslySetInnerHTML\s*[={:]/);
  assert.doesNotMatch(markdownSource, /dangerouslySetInnerHTML\s*[={:]/);
});

test("ParfaitResponseRenderer: renders the answer first, then sections, then follow-ups -- in that order", async () => {
  const source = await readFile(new URL("../components/parfait-response-renderer.tsx", import.meta.url), "utf8");
  const answerIndex = source.indexOf("response.answer");
  const sectionsIndex = source.indexOf("response.sections");
  const followUpsIndex = source.indexOf("response.followUps");
  assert.ok(answerIndex > -1 && sectionsIndex > -1 && followUpsIndex > -1);
  assert.ok(answerIndex < sectionsIndex);
  assert.ok(sectionsIndex < followUpsIndex);
});

test("ParfaitResponseRenderer: follow-up suggestions are capped at 3 and only rendered when a handler is provided", async () => {
  const source = await readFile(new URL("../components/parfait-response-renderer.tsx", import.meta.url), "utf8");
  assert.match(source, /response\.followUps\.slice\(0, 3\)/);
  assert.match(source, /onFollowUp && response\.followUps/);
});

test("ParfaitResponseRenderer: every section type has a distinct visual treatment (evidence quote, amber blocker/warning, emerald next_action/decision, plain list)", async () => {
  const source = await readFile(new URL("../components/parfait-response-renderer.tsx", import.meta.url), "utf8");
  assert.match(source, /border-amber-200 bg-amber-50/); // blocker/warning
  assert.match(source, /border-emerald-200 bg-emerald-50/); // next_action
  assert.match(source, /&ldquo;\{section\.content\}&rdquo;/); // evidence, quoted, not a raw ">" char
});

// ============================================================
// Shared prompt instructions -- do not ask the model for presentation.
// ============================================================

test("shared response instructions forbid the model from generating Markdown headings, HTML, CSS, or colors", async () => {
  const source = await readFile(new URL("../lib/parfait-response/prompt.ts", import.meta.url), "utf8");
  assert.match(source, /Do not generate Markdown headings, raw HTML, CSS, colors, icons/);
  assert.match(source, /Never fabricate evidence or quotations/);
  assert.match(source, /Answer the user's question directly in the first sentence/);
});

// ============================================================
// Commitment chat agent -- the first migrated surface.
// ============================================================

test("commitment chat agent: reuses the shared OpenAI client/model convention, not a separate client", async () => {
  const source = await readFile(new URL("../lib/commitment-chat/agent.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ getOpenAIModel, openai \} from "@\/lib\/openai";/);
  assert.match(source, /getOpenAIModel\(\)/);
});

test("commitment chat agent: uses the shared response schema/instructions, not a bespoke envelope", async () => {
  const source = await readFile(new URL("../lib/commitment-chat/agent.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ PARFAIT_RESPONSE_INSTRUCTIONS \} from "@\/lib\/parfait-response\/prompt";/);
  assert.match(source, /import \{ parfaitResponseJsonSchema, parseParfaitResponse \} from "@\/lib\/parfait-response\/schema";/);
  assert.match(source, /schema: parfaitResponseJsonSchema/);
  assert.match(source, /strict: true/);
});

test("commitment chat route: on agent success, persists structuredResponse in metadata and uses the plain answer as the legacy message column; on failure, never exposes the raw error to the user", async () => {
  const source = await readFile(
    new URL("../app/api/commitments/[id]/comments/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /assistantMetadata = \{ structuredResponse: agentResult\.response \}/);
  assert.match(source, /assistantMessage = agentResult\.response\.answer/);
  assert.doesNotMatch(source, /res(ponse)?\.json\(\{[^}]*agentResult\.error/);
  assert.match(source, /I could not generate a response right now/);
});

// ============================================================
// Other chat surfaces: legacy Markdown-safe rendering applied broadly, mutation/specialized
// behavior (pending patch, generated content, sources, proposal review) left completely untouched.
// ============================================================

test("task-clarifications, meeting-assistant-panel, and project-brain-panel all render assistant text through the shared renderer instead of a raw {message} div", async () => {
  for (const file of [
    "../components/task-clarifications.tsx",
    "../components/meeting-assistant-panel.tsx",
    "../components/project-brain-panel.tsx"
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /import \{ ParfaitResponseRenderer \} from "@\/components\/parfait-response-renderer";/);
    assert.match(source, /<ParfaitResponseRenderer/);
  }
});

test("task-clarifications: the pending-patch confirmation card is untouched by the renderer swap", async () => {
  const source = await readFile(new URL("../components/task-clarifications.tsx", import.meta.url), "utf8");
  assert.match(source, /Pending update/);
  assert.match(source, /Confirm to apply Parfait&apos;s exact proposed changes\./);
});

test("meeting-assistant-panel: generated-content cards and sources list are untouched by the renderer swap", async () => {
  const source = await readFile(new URL("../components/meeting-assistant-panel.tsx", import.meta.url), "utf8");
  assert.match(source, /generatedContent\.map/);
  assert.match(source, /Sources/);
});

test("project-brain-panel: proposed-changes card and Review/Reject buttons are untouched by the renderer swap", async () => {
  const source = await readFile(new URL("../components/project-brain-panel.tsx", import.meta.url), "utf8");
  assert.match(source, /Proposed changes/);
  assert.match(source, /Review changes/);
  assert.match(source, /void rejectProposal\(proposal\)/);
});

test("commitment correction assistant (entity-correction-assistant.tsx) is intentionally NOT migrated -- it is a field-diff proposal tool, not a general Q&A surface", async () => {
  const source = await readFile(new URL("../components/entity-correction-assistant.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ParfaitResponseRenderer/);
});

// ============================================================
// Backward compatibility: lib/types.ts's CommitmentComment metadata accommodates both the new
// structured-response shape and the pre-existing ai_correction audit shape on the same column,
// no migration.
// ============================================================

test("lib/types.ts: CommitmentCommentMetadata carries both structuredResponse and the existing ai_correction audit shape on one column", async () => {
  const source = await readFile(new URL("../lib/types.ts", import.meta.url), "utf8");
  assert.match(source, /interface CommitmentCommentMetadata/);
  assert.match(source, /structuredResponse\?: ParfaitResponse/);
  assert.match(source, /kind\?: "ai_correction"/);
});
