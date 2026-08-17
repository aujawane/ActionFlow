/**
 * A generic Markdown-ish document parser for Parfait's generated deliverables
 * (task_artifacts.content -- always plain text, see lib/types.ts's TaskArtifact). Deliberately
 * separate from lib/parfait-response/markdown.tsx (the chat-bubble fallback renderer): that module
 * is intentionally scoped to short, low-structure chat text and documents itself as "not a
 * general Markdown engine." Deliverables are long, model-free-styled documents (the generation
 * prompt in lib/task-workspace.ts gives no explicit Markdown instructions -- see the PR
 * description's audit) that commonly contain headings, tables, and multi-item lists chat text
 * never does, so this is a purpose-built parser rather than a stretched reuse of the smaller one.
 *
 * Pure data, no React import -- parsing is fully unit-testable without a JSX/DOM concern, and
 * components/deliverable-document.tsx is the only place this AST becomes UI.
 */

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

export type TableAlign = "left" | "center" | "right";

export type DocBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; spans: InlineNode[]; id: string }
  | { kind: "paragraph"; spans: InlineNode[] }
  | { kind: "list"; ordered: boolean; items: InlineNode[][] }
  | { kind: "table"; headers: InlineNode[][]; rows: InlineNode[][][]; align: TableAlign[] }
  | { kind: "blockquote"; spans: InlineNode[] }
  | { kind: "code"; content: string; language: string | null }
  | { kind: "hr" };

const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*#*$/;
const ORDERED_ITEM = /^\d+[.)]\s+(.+)$/;
const UNORDERED_ITEM = /^[-*+]\s+(.+)$/;
const QUOTE_LINE = /^>\s?(.*)$/;
const HR_LINE = /^(-{3,}|\*{3,}|_{3,})$/;
const FENCE_LINE = /^```\s*([a-zA-Z0-9_+-]*)\s*$/;
const TABLE_ROW = /^\|?(.+)\|?$/;
const TABLE_SEPARATOR_CELL = /^:?-{1,}:?$/;

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  // Split on unescaped pipes only -- a cell may legitimately contain "\|" for a literal pipe.
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isTableSeparatorRow(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell));
}

function alignFromSeparatorCell(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

/** Parses inline spans (bold/italic/inline code/links) out of a single logical line of text.
 * Deliberately flat (no nested emphasis) -- matches what models actually produce in practice and
 * keeps this both simple and safe (never eval's/interprets anything beyond these four forms). */
export function parseInlineSpans(text: string): InlineNode[] {
  const pattern = /(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(`[^`]+`)|(\*[^*]+\*)|(_[^_]+_)/g;
  const nodes: InlineNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (linkMatch && /^https?:\/\//i.test(linkMatch[2])) {
        nodes.push({ type: "link", text: linkMatch[1], href: linkMatch[2] });
      } else {
        nodes.push({ type: "text", text: linkMatch ? linkMatch[1] : token });
      }
    } else if (token.startsWith("**")) {
      nodes.push({ type: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("`")) {
      nodes.push({ type: "code", text: token.slice(1, -1) });
    } else {
      nodes.push({ type: "italic", text: token.slice(1, -1) });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push({ type: "text", text: text.slice(lastIndex) });
  return nodes;
}

function slugify(text: string, seen: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 60) || "section";
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/** Parses a raw deliverable's plain-text content into an ordered list of document blocks. Never
 * mutates or reinterprets the model's words -- purely a structural read of whatever headings,
 * lists, tables, and paragraphs are already present in the stored Markdown-ish text. */
export function parseDeliverableDocument(content: string): DocBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  const headingIds = new Map<string, number>();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fenceMatch = FENCE_LINE.exec(line);
    if (fenceMatch) {
      const language = fenceMatch[1] || null;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !FENCE_LINE.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      blocks.push({ kind: "code", content: codeLines.join("\n"), language });
      continue;
    }

    const headingMatch = HEADING_LINE.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const text = headingMatch[2].trim();
      blocks.push({
        kind: "heading",
        level,
        text,
        spans: parseInlineSpans(text),
        id: slugify(text, headingIds)
      });
      i++;
      continue;
    }

    if (HR_LINE.test(line.trim())) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    // A table needs at least a header row followed immediately by a valid separator row.
    if (TABLE_ROW.test(line) && line.includes("|") && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      const separatorCells = splitTableRow(lines[i + 1]);
      const align = separatorCells.map(alignFromSeparatorCell);
      i += 2;
      const rows: InlineNode[][][] = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i]).map(parseInlineSpans));
        i++;
      }
      blocks.push({
        kind: "table",
        headers: headerCells.map(parseInlineSpans),
        rows,
        align
      });
      continue;
    }

    if (QUOTE_LINE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && QUOTE_LINE.test(lines[i])) {
        quoteLines.push(QUOTE_LINE.exec(lines[i])![1]);
        i++;
      }
      blocks.push({ kind: "blockquote", spans: parseInlineSpans(quoteLines.join(" ")) });
      continue;
    }

    if (UNORDERED_ITEM.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && UNORDERED_ITEM.test(lines[i])) {
        items.push(parseInlineSpans(UNORDERED_ITEM.exec(lines[i])![1]));
        i++;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }

    if (ORDERED_ITEM.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && ORDERED_ITEM.test(lines[i])) {
        items.push(parseInlineSpans(ORDERED_ITEM.exec(lines[i])![1]));
        i++;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !HEADING_LINE.test(lines[i]) &&
      !HR_LINE.test(lines[i].trim()) &&
      !QUOTE_LINE.test(lines[i]) &&
      !UNORDERED_ITEM.test(lines[i]) &&
      !ORDERED_ITEM.test(lines[i]) &&
      !FENCE_LINE.test(lines[i]) &&
      !(TABLE_ROW.test(lines[i]) && lines[i].includes("|") && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1]))
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "paragraph", spans: parseInlineSpans(paragraphLines.join(" ")) });
  }

  return blocks;
}

export type DocSection = {
  heading: { level: 1 | 2 | 3 | 4 | 5 | 6; text: string; id: string } | null;
  blocks: DocBlock[];
};

/** Groups a flat block list into sections at each H1/H2 boundary -- H3+ headings and every other
 * block stay nested inside the current section's own block list. This is what lets the renderer
 * apply section-level treatment (summary card, recommendation callout, etc.) by heading text
 * without re-parsing; `heading: null` holds any content that appears before the first H1/H2. */
export function groupIntoSections(blocks: DocBlock[]): DocSection[] {
  const sections: DocSection[] = [];
  let current: DocSection = { heading: null, blocks: [] };

  for (const block of blocks) {
    if (block.kind === "heading" && (block.level === 1 || block.level === 2)) {
      if (current.heading !== null || current.blocks.length > 0) sections.push(current);
      current = { heading: { level: block.level, text: block.text, id: block.id }, blocks: [] };
      continue;
    }
    current.blocks.push(block);
  }
  if (current.heading !== null || current.blocks.length > 0) sections.push(current);
  return sections;
}
