import type { DocBlock, DocSection } from "@/lib/deliverable-document/parse";

/**
 * Deterministic heading-text classification -- no AI, no guessing which section "should" be the
 * recommendation. Every pattern here matches a heading Parfait's own deliverable-format
 * instructions already suggest (see DELIVERABLE_FORMAT_INSTRUCTIONS in lib/task-deliverables.ts)
 * or that models commonly produce for report-shaped content. If a document doesn't use any of
 * these headings, its sections simply render with the normal (non-special) treatment -- nothing
 * is invented or reclassified from content.
 */
export type SectionRole =
  | "summary"
  | "recommendation"
  | "next_steps"
  | "costs"
  | "security"
  | "risk"
  | "collapsible_detail"
  | "normal";

const SUMMARY_PATTERN = /^summary$/i;
const RECOMMENDATION_PATTERN = /^(final\s+recommendation|recommendation|recommended\s+approach|conclusion)$/i;
const NEXT_STEPS_PATTERN = /^(suggested\s+)?next\s+steps$|^action\s+plan$/i;
const COSTS_PATTERN = /^additional\s+costs?$|^costs?$|^pricing$/i;
const SECURITY_PATTERN = /^security$/i;
const RISK_PATTERN = /^risks?$|^considerations?$|^caveats?$|^limitations?$/i;
// Deliberately generic -- "comparison"/"findings" alone (not just "Plan Comparison"/"Detailed
// Findings" literally) so an unrelated report (vendor comparison, technology evaluation, etc.)
// gets the same treatment without the pattern being shaped around one example (section 28).
const COLLAPSIBLE_PATTERN = /comparison$|findings$|^technical\s+details$|^sources?$/i;

export function classifySectionHeading(headingText: string | undefined): SectionRole {
  if (!headingText) return "normal";
  const text = headingText.trim();
  if (SUMMARY_PATTERN.test(text)) return "summary";
  if (RECOMMENDATION_PATTERN.test(text)) return "recommendation";
  if (NEXT_STEPS_PATTERN.test(text)) return "next_steps";
  if (COSTS_PATTERN.test(text)) return "costs";
  if (SECURITY_PATTERN.test(text)) return "security";
  if (RISK_PATTERN.test(text)) return "risk";
  if (COLLAPSIBLE_PATTERN.test(text)) return "collapsible_detail";
  return "normal";
}

/** A rough content-weight measure (characters across every span/cell in a section) used only to
 * decide whether a "detail" section is long enough to be worth collapsing by default -- short
 * ones just render normally, never hidden behind a click for no reason. */
export function sectionContentLength(blocks: DocBlock[]): number {
  let length = 0;
  for (const block of blocks) {
    if (block.kind === "paragraph" || block.kind === "blockquote") {
      length += block.spans.reduce((sum, span) => sum + span.text.length, 0);
    } else if (block.kind === "list") {
      length += block.items.reduce(
        (sum, item) => sum + item.reduce((s, span) => s + span.text.length, 0),
        0
      );
    } else if (block.kind === "table") {
      length += block.rows.reduce(
        (sum, row) =>
          sum + row.reduce((rowSum, cell) => rowSum + cell.reduce((s, span) => s + span.text.length, 0), 0),
        0
      );
    } else if (block.kind === "code") {
      length += block.content.length;
    }
  }
  return length;
}

/** Long enough that progressive disclosure genuinely helps scanning (section 16) -- an arbitrary
 * but reasonable threshold, not a hardcoded per-document-title rule. */
export const COLLAPSIBLE_LENGTH_THRESHOLD = 500;

/** A document is only worth a table-of-contents nav if it actually has enough sections to get
 * lost in (section 17) -- short deliverables never show one. */
export function shouldShowTableOfContents(sections: DocSection[]): boolean {
  return sections.filter((section) => section.heading !== null).length >= 5;
}

const CHECK_PREFIX = /^(✓|✔|\[x\]|recommended:?)\s*/i;

/** Detects whether a list item or table cell already carries the report's own explicit
 * "recommended" marker -- used only to add emphasis to text that already says so, never to infer
 * a recommendation the content doesn't state (section 10/11). */
export function hasExplicitRecommendedMarker(text: string): boolean {
  return CHECK_PREFIX.test(text.trim()) || /\brecommended\b/i.test(text) || /\bbest\s+choice\b/i.test(text);
}
