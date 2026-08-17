"use client";

import { useMemo } from "react";
import type { ReactNode } from "react";

import type { DocBlock, DocSection, InlineNode, TableAlign } from "@/lib/deliverable-document/parse";
import { groupIntoSections, parseDeliverableDocument } from "@/lib/deliverable-document/parse";
import {
  COLLAPSIBLE_LENGTH_THRESHOLD,
  classifySectionHeading,
  hasExplicitRecommendedMarker,
  sectionContentLength,
  shouldShowTableOfContents
} from "@/lib/deliverable-document/sections";

/**
 * Turns a generated deliverable's plain-text Markdown-ish content (task_artifacts.content -- see
 * lib/deliverable-document/parse.ts) into a polished, scannable document. Presentation only: it
 * never rewrites, reorders, or reinterprets what the model wrote -- section treatment is chosen
 * purely from heading text already present in the content (lib/deliverable-document/sections.ts),
 * never inferred or generated. Content width is capped for readability (~75ch) inside whatever
 * container the caller provides; tables get their own horizontal-scroll region instead of being
 * squeezed to that width. Copy/edit/version/lifecycle behavior in deliverable-focused-view.tsx is
 * completely untouched -- this component only replaces the read-mode content block.
 */
export function DeliverableDocument({ content }: { content: string }) {
  const sections = useMemo(() => groupIntoSections(parseDeliverableDocument(content)), [content]);
  const showToc = useMemo(() => shouldShowTableOfContents(sections), [sections]);

  if (sections.length === 0) return null;

  return (
    <div className="space-y-6">
      {showToc ? <TableOfContents sections={sections} /> : null}
      {sections.map((section, index) => (
        <DocumentSection key={index} section={section} />
      ))}
    </div>
  );
}

function TableOfContents({ sections }: { sections: DocSection[] }) {
  const headed = sections.filter(
    (section): section is DocSection & { heading: NonNullable<DocSection["heading"]> } =>
      section.heading !== null
  );
  return (
    <nav aria-label="Report sections" className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">In this report</p>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {headed.map((section) => (
          <li key={section.heading.id} className="text-sm">
            <a href={`#${section.heading.id}`} className="text-brand-700 hover:underline">
              {section.heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function DocumentSection({ section }: { section: DocSection }) {
  const role = classifySectionHeading(section.heading?.text);

  if (role === "summary") return <SummarySection section={section} />;
  if (role === "recommendation") return <RecommendationSection section={section} />;
  if (role === "next_steps") return <NextStepsSection section={section} />;
  if (role === "costs") return <CalloutSection section={section} tone="quiet" />;
  if (role === "security") return <CalloutSection section={section} tone="quiet" />;
  if (role === "risk") return <CalloutSection section={section} tone="warning" />;
  if (role === "collapsible_detail") return <CollapsibleSection section={section} />;
  return <NormalSection section={section} />;
}

function SectionTitle({
  section,
  className
}: {
  section: DocSection;
  className: string;
}) {
  if (!section.heading) return null;
  if (section.heading.level === 1) {
    return (
      <h1 id={section.heading.id} className={className}>
        {section.heading.text}
      </h1>
    );
  }
  return (
    <h2 id={section.heading.id} className={className}>
      {section.heading.text}
    </h2>
  );
}

function NormalSection({ section }: { section: DocSection }) {
  return (
    <section>
      <SectionTitle section={section} className="text-lg font-semibold text-slate-950" />
      <div className={section.heading ? "mt-2 space-y-3" : "space-y-3"}>{renderBlocks(section.blocks)}</div>
    </section>
  );
}

/** The first heading matching "Summary" -- rendered as a subtle elevated card so the reader's
 * eye lands there first, per the product goal of understanding the gist in 5-10 seconds. */
function SummarySection({ section }: { section: DocSection }) {
  return (
    <section id={section.heading?.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
      {section.heading ? (
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{section.heading.text}</p>
      ) : null}
      <div className="mt-2 space-y-3 text-[15px] leading-[1.65] text-slate-800">
        {renderBlocks(section.blocks)}
      </div>
    </section>
  );
}

/** Recognizes "Recommendation" / "Final Recommendation" / "Recommended Approach" / "Conclusion"
 * headings and renders their content as the one green-accented callout in the document -- used
 * subtly (one card, not a color wash) per the brief's explicit "do not overuse green" guidance.
 * The section's first paragraph is given slightly more visual weight since it's almost always the
 * direct answer ("Shopify Basic.") the reader is scanning for. */
function RecommendationSection({ section }: { section: DocSection }) {
  return (
    <section id={section.heading?.id} className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
      {section.heading ? (
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">{section.heading.text}</p>
      ) : null}
      <div className="mt-2 space-y-3 text-[15px] leading-[1.65] text-emerald-950">
        {renderBlocks(section.blocks, { emphasizeFirstParagraph: true })}
      </div>
    </section>
  );
}

/** "Next Steps" / "Suggested Next Steps" / "Action Plan" -- the section's ordered list (if any)
 * renders as a numbered sequence with subtle circular markers; everything else in the section
 * (e.g. a lead-in sentence) renders normally above it. List order is never touched. */
function NextStepsSection({ section }: { section: DocSection }) {
  const listIndex = section.blocks.findIndex((block) => block.kind === "list" && block.ordered);
  const list = listIndex >= 0 ? (section.blocks[listIndex] as Extract<DocBlock, { kind: "list" }>) : null;
  const leadBlocks = listIndex >= 0 ? section.blocks.filter((_, index) => index !== listIndex) : section.blocks;

  return (
    <section id={section.heading?.id}>
      <SectionTitle section={section} className="text-lg font-semibold text-slate-950" />
      {leadBlocks.length > 0 ? (
        <div className={section.heading ? "mt-2 space-y-3" : "space-y-3"}>{renderBlocks(leadBlocks)}</div>
      ) : null}
      {list ? (
        <ol className="mt-3 space-y-2.5">
          {list.items.map((item, index) => (
            <li key={index} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-semibold text-emerald-800">
                {index + 1}
              </span>
              <span className="text-[15px] leading-6 text-slate-800">{renderSpans(item, `step-${index}`)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/** Shared, restrained treatment for Costs/Security ("quiet") and Risks/Considerations/Caveats/
 * Limitations ("warning") -- differentiated but never an aggressive alert box, per the brief's
 * explicit "do not make everything an alert box" instruction. */
function CalloutSection({ section, tone }: { section: DocSection; tone: "quiet" | "warning" }) {
  const boxClass =
    tone === "warning" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white";
  const labelClass = tone === "warning" ? "text-amber-800" : "text-slate-500";
  const bodyClass = tone === "warning" ? "text-amber-900" : "text-slate-700";
  return (
    <section id={section.heading?.id} className={`rounded-xl border p-4 ${boxClass}`}>
      {section.heading ? (
        <p className={`text-xs font-semibold uppercase tracking-wide ${labelClass}`}>{section.heading.text}</p>
      ) : null}
      <div className={`mt-2 space-y-3 text-sm leading-6 ${bodyClass}`}>{renderBlocks(section.blocks)}</div>
    </section>
  );
}

/** "Detailed Findings" / "Plan Comparison" / "Technical Details" / "Sources" -- only wrapped in a
 * native, keyboard-accessible <details> disclosure when the section is genuinely long
 * (sectionContentLength > COLLAPSIBLE_LENGTH_THRESHOLD); short ones render normally, never hidden
 * behind a click for no reason. The primary Summary/Recommendation sections are never routed
 * through this component at all (see classifySectionHeading), so they can never be collapsed. */
function CollapsibleSection({ section }: { section: DocSection }) {
  const isLong = sectionContentLength(section.blocks) > COLLAPSIBLE_LENGTH_THRESHOLD;

  if (!isLong) {
    return (
      <section id={section.heading?.id}>
        <SectionTitle section={section} className="text-lg font-semibold text-slate-950" />
        <div className={section.heading ? "mt-2 space-y-3" : "space-y-3"}>{renderBlocks(section.blocks)}</div>
      </section>
    );
  }

  return (
    <details id={section.heading?.id} className="group rounded-xl border border-slate-200 p-4">
      <summary className="flex cursor-pointer list-none items-center justify-between text-lg font-semibold text-slate-950">
        <span>{section.heading?.text}</span>
        <span className="text-xs font-medium text-slate-400 group-open:hidden">Show</span>
        <span className="hidden text-xs font-medium text-slate-400 group-open:inline">Hide</span>
      </summary>
      <div className="mt-3 space-y-3">{renderBlocks(section.blocks)}</div>
    </details>
  );
}

function renderBlocks(blocks: DocBlock[], options: { emphasizeFirstParagraph?: boolean } = {}): ReactNode {
  let emphasizedOnce = false;
  return blocks.map((block, index) => {
    if (block.kind === "heading") {
      const className =
        block.level === 3
          ? "text-sm font-semibold uppercase tracking-wide text-slate-600"
          : "text-sm font-semibold text-slate-700";
      if (block.level === 3) return <h3 key={index} id={block.id} className={className}>{block.text}</h3>;
      if (block.level === 4) return <h4 key={index} id={block.id} className={className}>{block.text}</h4>;
      if (block.level === 5) return <h5 key={index} id={block.id} className={className}>{block.text}</h5>;
      return <h6 key={index} id={block.id} className={className}>{block.text}</h6>;
    }

    if (block.kind === "paragraph") {
      const emphasize = Boolean(options.emphasizeFirstParagraph) && !emphasizedOnce;
      if (emphasize) emphasizedOnce = true;
      return (
        <p
          key={index}
          className={`max-w-[75ch] text-[15px] leading-[1.65] ${emphasize ? "font-medium" : ""}`}
        >
          {renderSpans(block.spans, `p-${index}`)}
        </p>
      );
    }

    if (block.kind === "list") {
      return <ListBlock key={index} block={block} />;
    }

    if (block.kind === "table") {
      return <TableBlock key={index} table={block} />;
    }

    if (block.kind === "blockquote") {
      return (
        <blockquote
          key={index}
          className="max-w-[75ch] border-l-2 border-slate-300 pl-3 italic leading-6 text-slate-600"
        >
          {renderSpans(block.spans, `bq-${index}`)}
        </blockquote>
      );
    }

    if (block.kind === "code") {
      return (
        <pre
          key={index}
          className="max-w-full overflow-x-auto rounded-lg bg-slate-900 px-3 py-2.5 text-xs leading-5 text-slate-100"
        >
          <code>{block.content}</code>
        </pre>
      );
    }

    return <hr key={index} className="border-slate-200" />;
  });
}

function ListBlock({ block }: { block: Extract<DocBlock, { kind: "list" }> }) {
  const items = block.items.map((item, index) => {
    const text = item.map((span) => span.text).join("");
    const recommended = hasExplicitRecommendedMarker(text);
    return (
      <li key={index} className={recommended ? "font-medium text-emerald-800" : undefined}>
        {renderSpans(item, `li-${index}`)}
      </li>
    );
  });

  const className = "max-w-[75ch] space-y-1.5 pl-5 text-[15px] leading-6 text-slate-700";
  return block.ordered ? (
    <ol className={`${className} list-decimal`}>{items}</ol>
  ) : (
    <ul className={`${className} list-disc`}>{items}</ul>
  );
}

function alignClass(align: TableAlign | undefined): string {
  if (align === "center") return "text-center";
  if (align === "right") return "text-right";
  return "text-left";
}

function TableBlock({ table }: { table: Extract<DocBlock, { kind: "table" }> }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full min-w-[420px] border-collapse text-sm">
        <thead className="bg-slate-50">
          <tr>
            {table.headers.map((cell, index) => (
              <th
                key={index}
                scope="col"
                className={`border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600 ${alignClass(table.align[index])}`}
              >
                {renderSpans(cell, `th-${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => {
                const cellText = cell.map((span) => span.text).join("");
                const recommended = hasExplicitRecommendedMarker(cellText);
                return (
                  <td
                    key={cellIndex}
                    className={`px-3 py-2.5 align-top leading-6 text-slate-700 ${alignClass(table.align[cellIndex])} ${
                      recommended ? "font-semibold text-emerald-800" : ""
                    }`}
                  >
                    {renderSpans(cell, `td-${rowIndex}-${cellIndex}`)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderSpans(spans: InlineNode[], keyPrefix: string): ReactNode {
  return spans.map((span, index) => {
    if (span.type === "text") return span.text;
    const key = `${keyPrefix}-${index}`;
    if (span.type === "bold") {
      return (
        <strong key={key} className="font-semibold text-slate-900">
          {span.text}
        </strong>
      );
    }
    if (span.type === "italic") return <em key={key}>{span.text}</em>;
    if (span.type === "code") {
      return (
        <code key={key} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em]">
          {span.text}
        </code>
      );
    }
    return (
      <a
        key={key}
        href={span.href}
        target="_blank"
        rel="noreferrer"
        className="break-words text-brand-700 underline underline-offset-2 hover:text-brand-800"
      >
        {span.text}
      </a>
    );
  });
}
