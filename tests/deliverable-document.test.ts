import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  groupIntoSections,
  parseDeliverableDocument,
  parseInlineSpans
} from "../lib/deliverable-document/parse";
import type { DocBlock } from "../lib/deliverable-document/parse";
import {
  COLLAPSIBLE_LENGTH_THRESHOLD,
  classifySectionHeading,
  hasExplicitRecommendedMarker,
  sectionContentLength,
  shouldShowTableOfContents
} from "../lib/deliverable-document/sections";

// ============================================================
// Fixtures -- a Shopify-style research report (the brief's own manual-QA example) and a second,
// unrelated report (payment API vendor comparison) used to prove the parser/renderer never
// depends on Shopify/plans/pricing-specific wording (section 28, generalization).
// ============================================================

const SHOPIFY_REPORT = `## Summary
Shopify Basic is the best plan for launching the store now. It balances cost and required features.

## Why Basic
Basic includes everything needed for a single-channel store: unlimited products, discount codes, and 2 staff accounts.

## Plan Comparison

| Plan | Price | Best for | Recommendation |
| --- | --- | --- | --- |
| Basic | $39/mo | New single-channel stores | ✓ Recommended |
| Shopify | $105/mo | Growing multi-channel stores | Not needed yet |
| Advanced | $399/mo | High-volume merchants | Overkill |

## Additional Costs
- Payment processing: 2.9% + 30 cents per transaction
- Apps: $0-50/month depending on needs
- Domain: ~$14/year

## Recommendation
Shopify Basic. Start monthly, then consider annual billing once traffic is stable.

## Security
Shopify handles PCI compliance and SSL automatically on all plans.

## Next Steps
1. Confirm budget
2. Create Shopify account
3. Select Basic
4. Configure payments

## Final Recommendation
Go with Shopify Basic on the monthly plan.
`;

const VENDOR_REPORT = `## Overview
We evaluated three payment API vendors for the checkout integration.

## Comparison

| Vendor | Latency | Support | Notes |
| --- | --- | --- | --- |
| Stripe | Low | Excellent | Recommended |
| Adyen | Medium | Good | Strong for EU |
| Braintree | Medium | Fair | Legacy integration risk |

## Risks
Switching vendors mid-quarter could delay the checkout redesign.

## Next Steps
1. Confirm contract terms
2. Set up sandbox credentials
3. Run integration tests
`;

// ============================================================
// Headings
// ============================================================

test("parseDeliverableDocument: recognizes H1-H6 and strips the leading # markers", () => {
  const blocks = parseDeliverableDocument("# Title\n\n## Section\n\n### Subsection");
  assert.deepEqual(
    blocks.map((block) => (block.kind === "heading" ? [block.level, block.text] : null)),
    [
      [1, "Title"],
      [2, "Section"],
      [3, "Subsection"]
    ]
  );
});

test("parseDeliverableDocument: heading ids are unique, url-safe slugs", () => {
  const blocks = parseDeliverableDocument("## Next Steps\n\ntext\n\n## Next Steps");
  const headings = blocks.filter((block): block is Extract<DocBlock, { kind: "heading" }> => block.kind === "heading");
  assert.equal(headings[0].id, "next-steps");
  assert.notEqual(headings[0].id, headings[1].id);
});

test("groupIntoSections: splits at H1/H2 boundaries, keeps H3+ nested inside the section", () => {
  const blocks = parseDeliverableDocument("## A\n\ntext\n\n### sub\n\nmore\n\n## B\n\nother");
  const sections = groupIntoSections(blocks);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].heading?.text, "A");
  assert.ok(sections[0].blocks.some((block) => block.kind === "heading" && block.level === 3));
  assert.equal(sections[1].heading?.text, "B");
});

test("groupIntoSections: content before the first heading is preserved under a null heading", () => {
  const blocks = parseDeliverableDocument("Lead-in text.\n\n## First heading\n\nbody");
  const sections = groupIntoSections(blocks);
  assert.equal(sections[0].heading, null);
  assert.equal(sections.length, 2);
});

// ============================================================
// Summary / recommendation classification
// ============================================================

test("classifySectionHeading: recognizes Summary, Recommendation variants, Next Steps variants, Costs, Security, Risk variants, and collapsible-detail headings", () => {
  assert.equal(classifySectionHeading("Summary"), "summary");
  assert.equal(classifySectionHeading("Recommendation"), "recommendation");
  assert.equal(classifySectionHeading("Final Recommendation"), "recommendation");
  assert.equal(classifySectionHeading("Recommended Approach"), "recommendation");
  assert.equal(classifySectionHeading("Conclusion"), "recommendation");
  assert.equal(classifySectionHeading("Next Steps"), "next_steps");
  assert.equal(classifySectionHeading("Suggested Next Steps"), "next_steps");
  assert.equal(classifySectionHeading("Action Plan"), "next_steps");
  assert.equal(classifySectionHeading("Additional Costs"), "costs");
  assert.equal(classifySectionHeading("Security"), "security");
  assert.equal(classifySectionHeading("Risks"), "risk");
  assert.equal(classifySectionHeading("Considerations"), "risk");
  assert.equal(classifySectionHeading("Caveats"), "risk");
  assert.equal(classifySectionHeading("Limitations"), "risk");
  assert.equal(classifySectionHeading("Detailed Findings"), "collapsible_detail");
  assert.equal(classifySectionHeading("Plan Comparison"), "collapsible_detail");
  assert.equal(classifySectionHeading("Sources"), "collapsible_detail");
});

test("classifySectionHeading: an unrecognized heading (and no heading at all) is 'normal', never invented", () => {
  assert.equal(classifySectionHeading("Why Basic"), "normal");
  assert.equal(classifySectionHeading("Overview"), "normal");
  assert.equal(classifySectionHeading(undefined), "normal");
});

test("classifySectionHeading: works identically on the unrelated vendor-comparison report -- no Shopify/plans/pricing-specific matching", () => {
  const sections = groupIntoSections(parseDeliverableDocument(VENDOR_REPORT));
  const roles = sections.map((section) => classifySectionHeading(section.heading?.text));
  assert.deepEqual(roles, ["normal", "collapsible_detail", "risk", "next_steps"]);
});

// ============================================================
// Tables
// ============================================================

test("parseDeliverableDocument: parses a Markdown table into headers/rows/align", () => {
  const blocks = parseDeliverableDocument(
    "| Plan | Price |\n| --- | ---: |\n| Basic | $39 |\n| Advanced | $399 |"
  );
  const table = blocks.find((block): block is Extract<DocBlock, { kind: "table" }> => block.kind === "table");
  assert.ok(table);
  assert.deepEqual(table!.headers.map((cell) => cell.map((s) => s.text).join("")), ["Plan", "Price"]);
  assert.equal(table!.rows.length, 2);
  assert.equal(table!.rows[0].map((cell) => cell.map((s) => s.text).join(""))[0], "Basic");
  assert.deepEqual(table!.align, ["left", "right"]);
});

test("parseDeliverableDocument: a non-table line with a stray pipe does not get misparsed as a table (no valid separator row follows)", () => {
  const blocks = parseDeliverableDocument("Use the A|B toggle to switch modes.\n\nNext paragraph.");
  assert.ok(blocks.every((block) => block.kind !== "table"));
});

test("Shopify fixture: the plan-comparison table has 4 columns and the Basic row is flagged recommended", () => {
  const sections = groupIntoSections(parseDeliverableDocument(SHOPIFY_REPORT));
  const comparisonSection = sections.find((section) => section.heading?.text === "Plan Comparison");
  const table = comparisonSection!.blocks.find(
    (block): block is Extract<DocBlock, { kind: "table" }> => block.kind === "table"
  );
  assert.ok(table);
  assert.equal(table!.headers.length, 4);
  const basicRow = table!.rows.find((row) => row[0].map((s) => s.text).join("") === "Basic");
  const recommendationCell = basicRow![3].map((s) => s.text).join("");
  assert.ok(hasExplicitRecommendedMarker(recommendationCell));
});

// ============================================================
// Lists (ordered / unordered) and next-steps ordering
// ============================================================

test("parseDeliverableDocument: an unordered list block preserves item text and order", () => {
  const blocks = parseDeliverableDocument("- First\n- Second\n- Third");
  const list = blocks.find((block): block is Extract<DocBlock, { kind: "list" }> => block.kind === "list");
  assert.equal(list!.ordered, false);
  assert.deepEqual(list!.items.map((item) => item.map((s) => s.text).join("")), ["First", "Second", "Third"]);
});

test("Shopify fixture: Next Steps ordered list preserves the model's original order (1-4, never reordered)", () => {
  const sections = groupIntoSections(parseDeliverableDocument(SHOPIFY_REPORT));
  const nextSteps = sections.find((section) => section.heading?.text === "Next Steps");
  const list = nextSteps!.blocks.find(
    (block): block is Extract<DocBlock, { kind: "list" }> => block.kind === "list"
  );
  assert.equal(list!.ordered, true);
  assert.deepEqual(list!.items.map((item) => item.map((s) => s.text).join("")), [
    "Confirm budget",
    "Create Shopify account",
    "Select Basic",
    "Configure payments"
  ]);
});

// ============================================================
// Inline spans: bold/italic/code/links
// ============================================================

test("parseInlineSpans: bold, italic, inline code, and a safe http(s) link", () => {
  const spans = parseInlineSpans("This is **bold**, *italic*, `code`, and a [link](https://example.com).");
  assert.deepEqual(
    spans.filter((s) => s.type !== "text").map((s) => s.type),
    ["bold", "italic", "code", "link"]
  );
  const link = spans.find((s) => s.type === "link");
  assert.equal(link && "href" in link ? link.href : null, "https://example.com");
});

test("parseInlineSpans: a non-http(s) link (e.g. javascript:) degrades to plain text, never an href", () => {
  const spans = parseInlineSpans("Click [here](javascript:alert(1)) now.");
  assert.ok(spans.every((span) => span.type !== "link"));
  assert.match(
    spans.map((s) => s.text).join(""),
    /here/
  );
});

test("parseInlineSpans: a raw (unlinked) long URL is left as plain text so it can wrap, not injected as a link", () => {
  const spans = parseInlineSpans("See https://example.com/a/very/long/path/that/should/wrap for details.");
  assert.ok(spans.every((span) => span.type !== "link"));
});

// ============================================================
// Long content: collapsible-detail threshold and table-of-contents gating
// ============================================================

test("sectionContentLength + COLLAPSIBLE_LENGTH_THRESHOLD: a short 'Detailed Findings' section is under threshold, a long one is over", () => {
  const shortBlocks = parseDeliverableDocument("Short detail.");
  assert.ok(sectionContentLength(shortBlocks) < COLLAPSIBLE_LENGTH_THRESHOLD);

  const longText = "Detail sentence. ".repeat(60);
  const longBlocks = parseDeliverableDocument(longText);
  assert.ok(sectionContentLength(longBlocks) > COLLAPSIBLE_LENGTH_THRESHOLD);
});

test("shouldShowTableOfContents: the 8-section Shopify report qualifies, the 4-section vendor report does not", () => {
  const shopifySections = groupIntoSections(parseDeliverableDocument(SHOPIFY_REPORT));
  const vendorSections = groupIntoSections(parseDeliverableDocument(VENDOR_REPORT));
  assert.equal(shouldShowTableOfContents(shopifySections), true);
  assert.equal(shouldShowTableOfContents(vendorSections), false);
});

test("shouldShowTableOfContents: a short deliverable (e.g. an email draft) with no headings never gets a table of contents", () => {
  const sections = groupIntoSections(parseDeliverableDocument("Hi team,\n\nHere is the update.\n\nThanks,\nParfait"));
  assert.equal(shouldShowTableOfContents(sections), false);
});

// ============================================================
// hasExplicitRecommendedMarker -- never infers, only detects text the report already states
// ============================================================

test("hasExplicitRecommendedMarker: detects checkmarks and the word 'recommended', not plain text", () => {
  assert.equal(hasExplicitRecommendedMarker("✓ Recommended"), true);
  assert.equal(hasExplicitRecommendedMarker("Recommended"), true);
  assert.equal(hasExplicitRecommendedMarker("Best choice"), true);
  assert.equal(hasExplicitRecommendedMarker("Not needed yet"), false);
  assert.equal(hasExplicitRecommendedMarker("Overkill"), false);
});

// ============================================================
// Historical/legacy content: plain text with no Markdown structure at all must still render
// without throwing -- these are exactly the artifacts stored before this renderer existed.
// ============================================================

test("parseDeliverableDocument: a legacy plain-text artifact (no headings, no lists, no tables) parses to plain paragraphs, never throws", () => {
  const legacyContent =
    "Hi Craig,\n\nFollowing up on our conversation. Let me know if you have any questions.\n\nBest,\nAditya";
  assert.doesNotThrow(() => parseDeliverableDocument(legacyContent));
  const blocks = parseDeliverableDocument(legacyContent);
  assert.ok(blocks.every((block) => block.kind === "paragraph"));
});

test("parseDeliverableDocument: empty content parses to an empty block list, not an error", () => {
  assert.deepEqual(parseDeliverableDocument(""), []);
  assert.deepEqual(parseDeliverableDocument("   \n\n  "), []);
});

// ============================================================
// Renderer component: structural checks (no DOM/RTL harness in this repo -- established
// convention, see tests/parfait-response.test.ts and tests/task-owner-select.test.ts).
// ============================================================

test("DeliverableDocument: uses real semantic elements (h2/h3, ul/ol, table/th/td, a) rather than faking structure with divs", async () => {
  const source = await readFile(new URL("../components/deliverable-document.tsx", import.meta.url), "utf8");
  assert.match(source, /<h1\b/);
  assert.match(source, /<h2\b/);
  assert.match(source, /<h3\b/);
  assert.match(source, /<table\b/);
  assert.match(source, /<thead\b/);
  assert.match(source, /scope="col"/);
  assert.match(source, /<ol\b/);
  assert.match(source, /<ul\b/);
  assert.match(source, /<blockquote\b/);
});

test("DeliverableDocument: tables get their own horizontal-scroll wrapper with a sensible minimum width, not page-level overflow", async () => {
  const source = await readFile(new URL("../components/deliverable-document.tsx", import.meta.url), "utf8");
  assert.match(source, /overflow-x-auto rounded-xl border border-slate-200/);
  assert.match(source, /min-w-\[420px\]/);
});

test("DeliverableDocument: body text is capped to a readable width (~75ch), tables are not", async () => {
  const source = await readFile(new URL("../components/deliverable-document.tsx", import.meta.url), "utf8");
  assert.match(source, /max-w-\[75ch\]/);
});

test("DeliverableDocument: collapsible sections use native <details>/<summary> (keyboard accessible), only when long, and only for detail-type headings -- never for Summary/Recommendation", async () => {
  const source = await readFile(new URL("../components/deliverable-document.tsx", import.meta.url), "utf8");
  assert.match(source, /<details\b/);
  assert.match(source, /<summary\b/);
  assert.match(source, /isLong/);
  const summaryFn = source.slice(
    source.indexOf("function SummarySection"),
    source.indexOf("function RecommendationSection")
  );
  const recommendationFn = source.slice(
    source.indexOf("function RecommendationSection"),
    source.indexOf("function NextStepsSection")
  );
  assert.doesNotMatch(summaryFn, /<details/);
  assert.doesNotMatch(recommendationFn, /<details/);
});

test("DeliverableDocument: the recommendation callout uses a restrained emerald treatment, not an aggressive/overused green wash", async () => {
  const source = await readFile(new URL("../components/deliverable-document.tsx", import.meta.url), "utf8");
  const recommendationFn = source.slice(
    source.indexOf("function RecommendationSection"),
    source.indexOf("function NextStepsSection")
  );
  assert.match(recommendationFn, /border-emerald-200 bg-emerald-50/);
  // Exactly one green card per recommendation section, not a page-wide wash -- no other section
  // component defaults to a green background.
  const summaryFn = source.slice(source.indexOf("function SummarySection"), source.indexOf("function RecommendationSection"));
  assert.doesNotMatch(summaryFn, /bg-emerald/);
});

test("DeliverableDocument: risk/caveat sections use a subtle amber treatment, not aggressive red", async () => {
  const source = await readFile(new URL("../components/deliverable-document.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /bg-rose|bg-red/);
  assert.match(source, /border-amber-200 bg-amber-50/);
});

test("DeliverableDocument: next-steps items render inside a real <ol> with a decorative numbered marker, order never altered by the renderer", async () => {
  const source = await readFile(new URL("../components/deliverable-document.tsx", import.meta.url), "utf8");
  const nextStepsFn = source.slice(
    source.indexOf("function NextStepsSection"),
    source.indexOf("function CalloutSection")
  );
  assert.match(nextStepsFn, /<ol\b/);
  assert.match(nextStepsFn, /list\.items\.map\(\(item, index\)/);
  assert.doesNotMatch(nextStepsFn, /\.reverse\(\)|\.sort\(/);
});

test("DeliverableDocument: table of contents only renders via shouldShowTableOfContents, never unconditionally", async () => {
  const source = await readFile(new URL("../components/deliverable-document.tsx", import.meta.url), "utf8");
  assert.match(source, /const showToc = useMemo\(\(\) => shouldShowTableOfContents\(sections\), \[sections\]\);/);
  assert.match(source, /\{showToc \? <TableOfContents/);
});

test("DeliverableDocument: never uses dangerouslySetInnerHTML -- everything is real React elements built from parsed data", async () => {
  const source = await readFile(new URL("../components/deliverable-document.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /dangerouslySetInnerHTML\s*[={:]/);
});

// ============================================================
// Integration with deliverable-focused-view.tsx: swapped only in read mode, everything else
// (edit textarea, copy, version history, lifecycle, failed-state branch) untouched.
// ============================================================

test("deliverable-focused-view: read mode renders through DeliverableDocument, edit mode still uses the plain textarea", async () => {
  const source = await readFile(new URL("../components/deliverable-focused-view.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ DeliverableDocument \} from "@\/components\/deliverable-document";/);
  assert.match(source, /<DeliverableDocument content=\{artifact\.content\} \/>/);
  assert.match(source, /<textarea\s[\s\S]*?value=\{editableContent\}/);
});

test("deliverable-focused-view: Copy still writes the raw artifact.content string, unaffected by rendering", async () => {
  const source = await readFile(new URL("../components/deliverable-focused-view.tsx", import.meta.url), "utf8");
  assert.match(source, /navigator\.clipboard\.writeText\(artifact\.content\)/);
});

test("deliverable-focused-view: the failed-generation branch never uses the new document renderer", async () => {
  const source = await readFile(new URL("../components/deliverable-focused-view.tsx", import.meta.url), "utf8");
  const failedBranch = source.slice(
    source.indexOf('lifecycleState === "failed" ? ('),
    source.indexOf(") : editing ? (")
  );
  assert.doesNotMatch(failedBranch, /DeliverableDocument/);
});

test("deliverable-focused-view: version history, restore, and lifecycle badge logic are untouched (still read status/accepted_at/version, never content)", async () => {
  const source = await readFile(new URL("../components/deliverable-focused-view.tsx", import.meta.url), "utf8");
  assert.match(source, /getDeliverableLifecycleState/);
  assert.match(source, /restoreThisVersion|\/restore/);
  assert.match(source, /history\.map/);
});

test("deliverable-focused-view: the document header (panel title / task title / lifecycle badge / version) already exists above the content block and needed no changes", async () => {
  const source = await readFile(new URL("../components/deliverable-focused-view.tsx", import.meta.url), "utf8");
  assert.match(source, /\{panelTitle\}/);
  assert.match(source, /<h1 className="text-2xl font-semibold tracking-tight text-slate-950">/);
  assert.match(source, /lifecycleBadgeClassName\(lifecycleState\)/);
  assert.match(source, /v\{artifact\.version\}/);
});
