import { createElement } from "react";
import type { ReactNode } from "react";

/**
 * The smallest safe Markdown-ish renderer this repo needs -- no dependency, no
 * dangerouslySetInnerHTML, no raw HTML passthrough. Every legacy assistant message (plain text
 * that may contain bold/italic/code/link/list/blockquote markdown syntax, written by a model with
 * no formatting instructions of its own) renders through this, so bold markers never show up as
 * literal asterisks in the UI. Supports exactly what section 9 of the PR description requires and
 * nothing more -- this is a fallback path for un-migrated surfaces, not a general Markdown engine.
 *
 * Built with React.createElement rather than JSX syntax deliberately: this module's output is
 * exercised directly by real unit tests (tests/parfait-response.test.ts), not just source-text
 * assertions, and this repo's TS config (`"jsx": "preserve"`) leaves JSX transformation entirely
 * to Next.js's own bundler -- there is no JSX runtime configured for plain `tsx`/Node execution.
 * `createElement` sidesteps that dependency completely and behaves identically either way.
 */

function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const pattern = /(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(`[^`]+`)|(\*[^*]+\*)|(_[^_]+_)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;

    if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (linkMatch && /^https?:\/\//i.test(linkMatch[2])) {
        nodes.push(
          createElement(
            "a",
            {
              key,
              href: linkMatch[2],
              target: "_blank",
              rel: "noreferrer",
              className: "text-brand-700 underline underline-offset-2 hover:text-brand-800"
            },
            linkMatch[1]
          )
        );
      } else {
        // Not a safe http(s) link (e.g. javascript:) -- render the label only, never the URL.
        nodes.push(linkMatch ? linkMatch[1] : token);
      }
    } else if (token.startsWith("**")) {
      nodes.push(createElement("strong", { key, className: "font-semibold" }, token.slice(2, -2)));
    } else if (token.startsWith("`")) {
      nodes.push(
        createElement(
          "code",
          { key, className: "rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em]" },
          token.slice(1, -1)
        )
      );
    } else {
      nodes.push(createElement("em", { key }, token.slice(1, -1)));
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

const UNORDERED_ITEM = /^[-*]\s+/;
const ORDERED_ITEM = /^\d+\.\s+/;
const QUOTE_LINE = /^>\s?/;

export function renderMarkdownText(text: string): ReactNode {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    if (QUOTE_LINE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && QUOTE_LINE.test(lines[i])) {
        quoteLines.push(lines[i].replace(QUOTE_LINE, ""));
        i++;
      }
      const key = blockKey++;
      blocks.push(
        createElement(
          "blockquote",
          { key, className: "border-l-2 border-slate-200 pl-3 italic text-slate-600" },
          parseInline(quoteLines.join(" "), `bq-${key}`)
        )
      );
      continue;
    }

    if (UNORDERED_ITEM.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UNORDERED_ITEM.test(lines[i])) {
        items.push(lines[i].replace(UNORDERED_ITEM, ""));
        i++;
      }
      const key = blockKey++;
      blocks.push(
        createElement(
          "ul",
          { key, className: "list-disc space-y-1 pl-5" },
          items.map((item, itemIndex) =>
            createElement("li", { key: itemIndex }, parseInline(item, `ul-${key}-${itemIndex}`))
          )
        )
      );
      continue;
    }

    if (ORDERED_ITEM.test(line)) {
      const items: string[] = [];
      while (i < lines.length && ORDERED_ITEM.test(lines[i])) {
        items.push(lines[i].replace(ORDERED_ITEM, ""));
        i++;
      }
      const key = blockKey++;
      blocks.push(
        createElement(
          "ol",
          { key, className: "list-decimal space-y-1 pl-5" },
          items.map((item, itemIndex) =>
            createElement("li", { key: itemIndex }, parseInline(item, `ol-${key}-${itemIndex}`))
          )
        )
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !QUOTE_LINE.test(lines[i]) &&
      !UNORDERED_ITEM.test(lines[i]) &&
      !ORDERED_ITEM.test(lines[i])
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }
    const key = blockKey++;
    blocks.push(createElement("p", { key }, parseInline(paragraphLines.join(" "), `p-${key}`)));
  }

  return blocks;
}
