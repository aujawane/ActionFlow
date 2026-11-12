import { TranscriptImportError } from "@/lib/transcript-import/errors";
import type { TranscriptFileFormat } from "@/lib/transcript-import/input";
import { CUE_MERGE_TARGET_CHARS } from "@/lib/transcript-import/limits";
import { removeDelimitedSpans, stripBoldEmphasis } from "@/lib/transcript-import/emphasis";
import { collapseWhitespace } from "@/lib/transcript-import/split";

/**
 * Pure transcript parser: normalized text in, ordered speaker turns out. No I/O.
 *
 * Rules every format follows:
 * - Source order is preserved; turns are emitted in the order they appear.
 * - A speaker is recorded only when the source names one explicitly AND the evidence that the
 *   document is dialogue is strong enough. Everything else is `null`, which the app already
 *   renders as "Unknown Speaker" (lib/transcript-speaker.ts). Nothing is guessed.
 * - Times in the source are offsets from the start of the recording. They are kept as offsets in
 *   milliseconds and are never turned into calendar timestamps.
 * - Text is whitespace-collapsed; words and punctuation are never changed. Markup that is not
 *   speech (subtitle tags, markdown emphasis markers) is removed.
 */

export type DetectedTranscriptFormat =
  | "webvtt"
  | "srt"
  | "timestamped_speaker_blocks"
  | "speaker_labeled"
  | "plain_text";

export type TranscriptContainer = "text" | "markdown" | "webvtt" | "srt";

export type ParsedTurn = {
  speaker: string | null;
  text: string;
  startOffsetMs: number | null;
  endOffsetMs: number | null;
  /** 1-based line in the normalized input where this turn starts. */
  sourceLine: number;
  /** Subtitle formats only: first and last cue (1-based, in file order) merged into this turn. */
  cueRange: [number, number] | null;
};

export type TranscriptImportWarningCode =
  | "no_speakers_detected"
  | "uncertain_speaker_labels"
  | "speaker_labels_not_trusted"
  | "format_detected_from_content"
  | "timing_not_monotonic"
  | "empty_cues_skipped"
  | "segments_split"
  | "segment_hard_split"
  | "meeting_date_missing";

export type TranscriptImportWarning = {
  code: TranscriptImportWarningCode;
  message: string;
  details?: Record<string, unknown>;
};

export type ParsedTranscript = {
  format: DetectedTranscriptFormat;
  container: TranscriptContainer;
  turns: ParsedTurn[];
  warnings: TranscriptImportWarning[];
};

// ------------------------------------------------------------------------------------- names

/** Words that introduce a heading or a field in notes, not a person speaking. Compared
 * case-insensitively against the whole label. Role labels (Host, Interviewer, Customer) are
 * deliberately absent: in transcripts they are how a speaker is identified. */
const NON_SPEAKER_LABELS = new Set(
  [
    "note", "notes", "nb", "n.b.", "ps", "p.s.", "fyi", "tip", "warning", "caution", "important",
    "reminder", "action", "action item", "action items", "todo", "to do", "to-do", "agenda",
    "summary", "recap", "overview", "minutes", "decision", "decisions", "next step", "next steps",
    "follow up", "follow-up", "followup", "follow ups", "follow-ups", "question", "questions",
    "open question", "open questions", "answer", "q", "a", "update", "updates", "re", "subject",
    "date", "time", "duration", "start", "end", "location", "where", "when", "who", "what", "why",
    "how", "attendees", "participants", "present", "absent", "organizer", "title", "meeting",
    "topic", "topics", "owner", "owners", "assignee", "due", "deadline", "status", "priority",
    "priorities", "example", "examples", "background", "context", "goal", "goals", "objective",
    "objectives", "purpose", "problem", "solution", "outcome", "result", "results", "conclusion",
    "takeaway", "takeaways", "key point", "key points", "highlights", "transcript", "recording",
    "link", "links", "url", "http", "https", "email", "phone", "chapter", "section", "part", "step",
    "item", "point", "risk", "risks", "blocker", "blockers", "issue", "issues", "bug", "feature",
    "requirement", "requirements", "budget", "timeline", "scope", "milestone", "milestones",
    "metrics", "kpi", "kpis", "cost", "price", "total", "deliverable", "deliverables",
    "dependency", "dependencies", "comment", "comments", "feedback", "observation",
    "observations", "recommendation", "recommendations", "edit", "edited", "source", "sources",
    "reference", "references", "attachment", "attachments", "version", "ticket", "tickets", "task",
    "tasks", "project", "projects", "also", "however", "therefore", "meanwhile", "definition",
    "rule", "rules", "warning", "error"
  ]
);

/** Explicit "we don't know who this is" labels: a turn boundary, but no speaker. */
const UNKNOWN_SPEAKER_LABELS = new Set(["unknown", "unknown speaker", "speaker", "?", "??", "unidentified"]);

const NAME_PARTICLES = new Set(["de", "da", "del", "della", "der", "den", "di", "du", "la", "le", "van", "von", "bin", "al", "el", "y", "of"]);
const NAME_WORD = /^(?:[\p{Lu}\p{Lo}][\p{L}\p{M}'’.\-]*|\d{1,3})$/u;

type NameVerdict = { kind: "speaker"; name: string } | { kind: "unknown" } | { kind: "not_a_name" };

/** Whether `raw` (the text before a colon, or beside a time) is plausibly a person's label. */
export function classifySpeakerLabel(raw: string): NameVerdict {
  const name = collapseWhitespace(raw);
  if (!name || name.length > 40) return { kind: "not_a_name" };
  const lower = name.toLowerCase();
  if (UNKNOWN_SPEAKER_LABELS.has(lower)) return { kind: "unknown" };
  if (NON_SPEAKER_LABELS.has(lower)) return { kind: "not_a_name" };

  // An optional short parenthetical qualifier: "Craig (PM)", "Dana (guest)".
  const qualified = /^(.*?)\s*\(([^()]{1,30})\)$/.exec(name);
  const base = qualified ? qualified[1] : name;
  const words = base.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 4) return { kind: "not_a_name" };
  if (!/^[\p{Lu}\p{Lo}]/u.test(words[0])) return { kind: "not_a_name" };
  if (!/\p{L}/u.test(base)) return { kind: "not_a_name" };
  if (NON_SPEAKER_LABELS.has(words[0].toLowerCase()) && words.length > 1 && !/^\d+$/.test(words[1])) {
    // "Action item", "Next steps", "Key points": a heading even when written in title case.
    if (NON_SPEAKER_LABELS.has(base.toLowerCase()) || NON_SPEAKER_LABELS.has(`${words[0]} ${words[1]}`.toLowerCase())) {
      return { kind: "not_a_name" };
    }
  }
  const valid = words.every((word, index) => NAME_WORD.test(word) || (index > 0 && NAME_PARTICLES.has(word)));
  return valid ? { kind: "speaker", name } : { kind: "not_a_name" };
}

/** `Name: text` / `Name:` on one line. The colon must not be part of a URL or a clock time. */
const LABEL_LINE = /^([^:\n]{1,60}?)\s*:(?!\/\/)(?:\s+(.*)|\s*)$/;

function matchLabelLine(line: string): { verdict: NameVerdict; rest: string } | null {
  const match = LABEL_LINE.exec(line.trim());
  if (!match) return null;
  if (/\d$/.test(match[1]) && /^\d/.test(match[2] ?? "")) return null; // "10:30" style clock text
  return { verdict: classifySpeakerLabel(match[1]), rest: match[2] ?? "" };
}

// ------------------------------------------------------------------------------------- times

const TIME = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?`;

/** "1:02:03", "02:03", "02:03.5", "00:02:13,250" to milliseconds; null when not a valid offset. */
export function parseClockOffset(value: string): number | null {
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (seconds > 59 || (match[1] !== undefined && minutes > 59)) return null;
  const millis = match[4] ? Number(match[4].padEnd(3, "0")) : 0;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

// ------------------------------------------------------------------------------------- cues

const CUE_TIMING = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/;

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lrm;|&rlm;/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "";
  return String.fromCodePoint(value);
}

/** Removes subtitle markup (<i>, <c.x>, <v ...>, inline <00:00:01.000> times, {\an8}). */
function stripCueMarkup(text: string): string {
  return decodeEntities(removeDelimitedSpans(removeDelimitedSpans(text, "<", ">"), "{\\", "}"));
}

type CuePart = {
  cueNumber: number;
  speaker: string | null;
  /** Whether the speaker came from an explicit <v> voice tag (strong evidence on its own). */
  voiceTagged: boolean;
  text: string;
  startOffsetMs: number;
  endOffsetMs: number;
  sourceLine: number;
};

type Block = { lines: string[]; firstLine: number };

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) {
      if (current) blocks.push(current);
      current = null;
      return;
    }
    if (!current) current = { lines: [], firstLine: index + 1 };
    current.lines.push(line);
  });
  if (current) blocks.push(current);
  return blocks;
}

function malformedCue(line: number, reason: string): TranscriptImportError {
  return new TranscriptImportError("malformed_cue", `Malformed subtitle cue at line ${line}: ${reason}.`, {
    details: { line }
  });
}

function parseCueTiming(line: string, lineNumber: number, flavour: "webvtt" | "srt") {
  const match = CUE_TIMING.exec(line.trim());
  if (!match) throw malformedCue(lineNumber, "expected 'start --> end'");
  const valid = flavour === "webvtt" ? /^(?:\d+:)?\d{2}:\d{2}\.\d{3}$/ : /^\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}$/;
  if (!valid.test(match[1]) || !valid.test(match[2])) throw malformedCue(lineNumber, "invalid cue time");
  const start = parseClockOffset(match[1]);
  const end = parseClockOffset(match[2]);
  if (start === null || end === null) throw malformedCue(lineNumber, "invalid cue time");
  if (end < start) throw malformedCue(lineNumber, "cue ends before it starts");
  return { start, end };
}

const VOICE_TAG = /^\s*<v(?:\.[^\s>]*)?(?:\s+([^>]*))?>/;

function parseWebVtt(text: string): { parts: CuePart[]; emptyCues: number } {
  const blocks = splitBlocks(text);
  const parts: CuePart[] = [];
  let emptyCues = 0;
  let cueNumber = 0;
  blocks.forEach((block, blockIndex) => {
    const first = block.lines[0].trim();
    if (blockIndex === 0) {
      if (!/^WEBVTT(?:[ \t].*)?$/.test(first)) throw malformedCue(block.firstLine, "missing WEBVTT header");
      return; // header block (may carry metadata lines)
    }
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(first)) return;

    const timingIndex = block.lines[0].includes("-->") ? 0 : block.lines[1]?.includes("-->") ? 1 : -1;
    if (timingIndex < 0) throw malformedCue(block.firstLine, "cue has no timing line");
    const { start, end } = parseCueTiming(block.lines[timingIndex], block.firstLine + timingIndex, "webvtt");
    cueNumber += 1;

    let speaker: string | null = null;
    let voiceTagged = false;
    let produced = false;
    let buffer: string[] = [];
    let bufferLine = block.firstLine + timingIndex + 1;
    const flush = () => {
      const content = collapseWhitespace(stripCueMarkup(buffer.join(" ")));
      if (content) {
        parts.push({ cueNumber, speaker, voiceTagged, text: content, startOffsetMs: start, endOffsetMs: end, sourceLine: bufferLine });
        produced = true;
      }
      buffer = [];
    };
    block.lines.slice(timingIndex + 1).forEach((line, offset) => {
      const voice = VOICE_TAG.exec(line);
      if (voice) {
        flush();
        const verdict = classifySpeakerLabel(decodeEntities(voice[1] ?? ""));
        // A voice tag is the file's own explicit speaker annotation; only an empty or
        // "unknown" voice is left without a name.
        speaker = verdict.kind === "unknown" || !collapseWhitespace(voice[1] ?? "") ? null : collapseWhitespace(decodeEntities(voice[1] ?? ""));
        voiceTagged = speaker !== null;
        bufferLine = block.firstLine + timingIndex + 1 + offset;
      }
      buffer.push(line);
    });
    flush();
    if (!produced) emptyCues += 1;
  });
  return { parts, emptyCues };
}

function parseSrt(text: string): { parts: CuePart[]; emptyCues: number } {
  const parts: CuePart[] = [];
  let emptyCues = 0;
  let cueNumber = 0;
  for (const block of splitBlocks(text)) {
    let timingIndex = 0;
    if (/^\d+$/.test(block.lines[0].trim())) timingIndex = 1;
    const timingLine = block.lines[timingIndex];
    if (timingLine === undefined || !timingLine.includes("-->")) {
      throw malformedCue(block.firstLine + timingIndex, "cue has no timing line");
    }
    const { start, end } = parseCueTiming(timingLine, block.firstLine + timingIndex, "srt");
    cueNumber += 1;
    const content = collapseWhitespace(stripCueMarkup(block.lines.slice(timingIndex + 1).join(" ")));
    if (!content) {
      emptyCues += 1;
      continue;
    }
    parts.push({
      cueNumber,
      speaker: null,
      voiceTagged: false,
      text: content,
      startOffsetMs: start,
      endOffsetMs: end,
      sourceLine: block.firstLine + timingIndex + 1
    });
  }
  return { parts, emptyCues };
}

/** Is there enough evidence that `Name:` prefixes in this document are speaker labels? */
function trustSpeakerLabels(names: string[], unitCount: number): boolean {
  if (names.length < 2) return false;
  const distinct = new Set(names).size;
  const ratio = names.length / Math.max(1, unitCount);
  return distinct >= 2 ? ratio >= 0.3 : ratio >= 0.5;
}

/** Names used exactly once, reported only when there are enough labels for a one-off to stand
 * out (in a three-line exchange, someone speaking once is normal). */
function singleUseNames(names: string[]): string[] {
  if (names.length < 6) return [];
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].filter(([, count]) => count === 1).map(([name]) => name);
}

function cueTurns(
  parsed: { parts: CuePart[]; emptyCues: number },
  warnings: TranscriptImportWarning[]
): ParsedTurn[] {
  const { parts } = parsed;
  // "Name: text" inside cue payloads (Zoom's VTT, most SRT) counts only with document-level evidence.
  const labelled = parts.map((part) => {
    if (part.voiceTagged) return null;
    const label = matchLabelLine(part.text);
    return label && label.verdict.kind !== "not_a_name" && label.rest ? label : null;
  });
  const labelNames = labelled.flatMap((label) => (label?.verdict.kind === "speaker" ? [label.verdict.name] : []));
  const untagged = parts.filter((part) => !part.voiceTagged).length;
  const trusted = trustSpeakerLabels(labelNames, untagged);
  if (trusted) {
    parts.forEach((part, index) => {
      const label = labelled[index];
      if (!label) return;
      part.speaker = label.verdict.kind === "speaker" ? label.verdict.name : null;
      part.text = collapseWhitespace(label.rest);
    });
    const uncertain = singleUseNames(labelNames);
    if (uncertain.length > 0) {
      warnings.push({
        code: "uncertain_speaker_labels",
        message: "Some speaker names appear only once and may not be speakers.",
        details: { labels: uncertain }
      });
    }
  } else if (labelNames.length > 0) {
    warnings.push({
      code: "speaker_labels_not_trusted",
      message: "Some lines look like 'Name: text', but too few to treat them as speaker labels. They were kept as text.",
      details: { labelCount: labelNames.length }
    });
  }

  if (parsed.emptyCues > 0) {
    warnings.push({ code: "empty_cues_skipped", message: "Subtitle cues with no text were skipped.", details: { count: parsed.emptyCues } });
  }
  if (parts.some((part, index) => index > 0 && part.startOffsetMs < parts[index - 1].startOffsetMs)) {
    warnings.push({ code: "timing_not_monotonic", message: "Cue times go backwards in places. File order was kept." });
  }

  // Re-join consecutive cues from the same speaker (subtitles cut speech into short lines).
  const turns: ParsedTurn[] = [];
  for (const part of parts) {
    const last = turns.at(-1);
    if (last && last.speaker === part.speaker && last.text.length + 1 + part.text.length <= CUE_MERGE_TARGET_CHARS) {
      last.text = `${last.text} ${part.text}`;
      last.endOffsetMs = Math.max(last.endOffsetMs ?? part.endOffsetMs, part.endOffsetMs);
      last.cueRange = [last.cueRange![0], part.cueNumber];
      continue;
    }
    turns.push({
      speaker: part.speaker,
      text: part.text,
      startOffsetMs: part.startOffsetMs,
      endOffsetMs: part.endOffsetMs,
      sourceLine: part.sourceLine,
      cueRange: [part.cueNumber, part.cueNumber]
    });
  }
  return turns;
}

// ------------------------------------------------------------------------------------- markdown

const MARKDOWN_SIGNAL = /^\s{0,3}(?:#{1,6}\s+\S|(?:\*\*|__)[^*_\n]{1,60}(?:\*\*|__)\s*:|(?:\*\*|__)[^*_\n]{1,60}:(?:\*\*|__))/;

function looksLikeMarkdown(text: string): boolean {
  let signals = 0;
  for (const line of text.split("\n")) {
    if (MARKDOWN_SIGNAL.test(line) && ++signals >= 2) return true;
  }
  return false;
}

/** Markdown to plain lines, keeping line numbers (removed lines become blank). Headings keep their
 * words and are flagged so they are never read as speaker labels. */
function stripMarkdown(text: string): { lines: string[]; headings: Set<number> } {
  const source = text.split("\n");
  const lines: string[] = [];
  const headings = new Set<number>();
  let inFrontMatter = source[0]?.trim() === "---";
  let inFence = false;
  source.forEach((line, index) => {
    if (inFrontMatter) {
      if (index > 0 && line.trim() === "---") inFrontMatter = false;
      lines.push("");
      return;
    }
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      lines.push("");
      return;
    }
    if (inFence) {
      lines.push(line);
      return;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      lines.push("");
      return;
    }
    let out = line;
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(out);
    if (heading) {
      out = heading[1];
      headings.add(index);
    }
    out = out
      .replace(/^\s{0,3}>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "")
      // "**Craig:** text" / "**Craig**: text" / "*Craig:*" -> "Craig: text"
      .replace(/^(\*\*|__|\*|_)([^*_\n]{1,60}?):\1(\s|$)/, "$2:$3")
      .replace(/^(\*\*|__|\*|_)([^*_\n]{1,60}?)\1\s*:/, "$2:");
    // Bold emphasis anywhere in the line. A linear scan, not a regex: see emphasis.ts.
    out = stripBoldEmphasis(out);
    lines.push(out);
  });
  return { lines, headings };
}

// ------------------------------------------------------------------------------------- text

type LineKind =
  | { kind: "blank" }
  | { kind: "content"; text: string }
  /** Starts a turn. `speaker` null means an explicit unknown label or a bare time marker. */
  | { kind: "turn"; speaker: string | null; text: string; offsetMs: number | null; timed: boolean; labelName: string | null };

const BRACKETED_TIME_PREFIX = new RegExp(String.raw`^[\[(](${TIME})[\])]\s*(?:[-–—]\s*)?(.*)$`);
const BARE_TIME_PREFIX = new RegExp(String.raw`^(${TIME})\s+(?:[-–—]\s*)?(.+)$`);
const NAME_THEN_TIME = new RegExp(String.raw`^(.{1,60}?)\s+[\[(]?(${TIME})[\])]?\s*(?::\s*(.*))?$`);

/** Classifies one line. `nextLineIsContent` lets a bare "[00:02:13] Craig" header count only
 * when speech actually follows it on the next line (otherwise "[00:01] Thanks Craig" would make a
 * speaker out of "Thanks Craig"). */
function classifyLine(line: string, isHeading: boolean, nextLineIsContent: boolean): LineKind {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "blank" };
  if (isHeading) return { kind: "content", text: trimmed };

  const timed = BRACKETED_TIME_PREFIX.exec(trimmed) ?? BARE_TIME_PREFIX.exec(trimmed);
  if (timed) {
    const offsetMs = parseClockOffset(timed[1]);
    const rest = timed[2]?.trim() ?? "";
    if (offsetMs !== null) {
      const label = rest ? matchLabelLine(rest) : null;
      if (label && label.verdict.kind !== "not_a_name") {
        return {
          kind: "turn",
          speaker: label.verdict.kind === "speaker" ? label.verdict.name : null,
          text: label.rest,
          offsetMs,
          timed: true,
          labelName: label.verdict.kind === "speaker" ? label.verdict.name : null
        };
      }
      const nameOnly = rest ? classifySpeakerLabel(rest.replace(/:$/, "")) : null;
      if (nameOnly && nameOnly.kind !== "not_a_name" && nextLineIsContent) {
        return {
          kind: "turn",
          speaker: nameOnly.kind === "speaker" ? nameOnly.name : null,
          text: "",
          offsetMs,
          timed: true,
          labelName: nameOnly.kind === "speaker" ? nameOnly.name : null
        };
      }
      // A bracketed time marker with speech but no speaker: a new turn, speaker unknown.
      if (BRACKETED_TIME_PREFIX.test(trimmed)) {
        return { kind: "turn", speaker: null, text: rest, offsetMs, timed: true, labelName: null };
      }
    }
  }

  const nameThenTime = NAME_THEN_TIME.exec(trimmed);
  if (nameThenTime) {
    const verdict = classifySpeakerLabel(nameThenTime[1]);
    const offsetMs = parseClockOffset(nameThenTime[2]);
    const inline = nameThenTime[3]?.trim() ?? "";
    if (verdict.kind !== "not_a_name" && offsetMs !== null && (inline || nextLineIsContent)) {
      return {
        kind: "turn",
        speaker: verdict.kind === "speaker" ? verdict.name : null,
        text: inline,
        offsetMs,
        timed: true,
        labelName: verdict.kind === "speaker" ? verdict.name : null
      };
    }
  }

  const label = matchLabelLine(trimmed);
  if (label && label.verdict.kind !== "not_a_name" && (label.rest || nextLineIsContent)) {
    return {
      kind: "turn",
      speaker: label.verdict.kind === "speaker" ? label.verdict.name : null,
      text: label.rest,
      offsetMs: null,
      timed: false,
      labelName: label.verdict.kind === "speaker" ? label.verdict.name : null
    };
  }
  return { kind: "content", text: trimmed };
}

function parseText(lines: string[], headings: Set<number>, warnings: TranscriptImportWarning[]) {
  const kinds: LineKind[] = lines.map((line, index) => {
    const next = lines[index + 1];
    const nextIsContent = next !== undefined && next.trim().length > 0;
    return classifyLine(line, headings.has(index), nextIsContent);
  });

  const paragraphs = splitBlocks(lines.join("\n")).length;
  const timedTurns = kinds.filter((k) => k.kind === "turn" && k.timed).length;
  const labelNames = kinds.flatMap((k) => (k.kind === "turn" && k.labelName ? [k.labelName] : []));
  // Untimed "Name:" turns; an explicit "Unknown:" label counts as a turn but not as a name.
  const untimedLabels = kinds.flatMap((k) => (k.kind === "turn" && !k.timed ? [k.labelName ?? "(unknown)"] : []));

  let format: DetectedTranscriptFormat;
  if (timedTurns >= 2 && timedTurns >= untimedLabels.length) format = "timestamped_speaker_blocks";
  else if (trustSpeakerLabels(untimedLabels, paragraphs)) format = "speaker_labeled";
  else format = "plain_text";

  if (format === "plain_text") {
    if (labelNames.length > 0 || timedTurns > 0) {
      warnings.push({
        code: "speaker_labels_not_trusted",
        message: "Some lines look like speaker labels, but too few to treat the text as dialogue. They were kept as text.",
        details: { labelCount: labelNames.length + timedTurns }
      });
    }
    return {
      format,
      turns: splitBlocks(lines.join("\n")).map((block) => ({
        speaker: null,
        text: collapseWhitespace(block.lines.join(" ")),
        startOffsetMs: null,
        endOffsetMs: null,
        sourceLine: block.firstLine,
        cueRange: null
      }))
    };
  }

  // Dialogue: each turn line starts a turn; content lines continue the current turn. Content
  // before the first turn (a title, a preamble) becomes unknown-speaker turns, one per paragraph.
  const turns: ParsedTurn[] = [];
  let current: ParsedTurn | null = null;
  let preamble: ParsedTurn | null = null;
  const pushText = (turn: ParsedTurn, text: string) => {
    turn.text = turn.text ? `${turn.text} ${text}` : text;
  };
  kinds.forEach((kind, index) => {
    const lineNumber = index + 1;
    if (kind.kind === "blank") {
      preamble = null;
      return;
    }
    if (kind.kind === "turn") {
      current = {
        speaker: kind.speaker,
        text: collapseWhitespace(kind.text),
        startOffsetMs: kind.offsetMs,
        endOffsetMs: null,
        sourceLine: lineNumber,
        cueRange: null
      };
      turns.push(current);
      return;
    }
    const text = collapseWhitespace(kind.text);
    if (current) {
      pushText(current, text);
      return;
    }
    if (!preamble) {
      preamble = { speaker: null, text: "", startOffsetMs: null, endOffsetMs: null, sourceLine: lineNumber, cueRange: null };
      turns.push(preamble);
    }
    pushText(preamble, text);
  });

  const uncertain = singleUseNames(labelNames);
  if (uncertain.length > 0) {
    warnings.push({
      code: "uncertain_speaker_labels",
      message: "Some speaker names appear only once and may not be speakers.",
      details: { labels: uncertain }
    });
  }
  const offsets = turns.flatMap((turn) => (turn.startOffsetMs === null ? [] : [turn.startOffsetMs]));
  if (offsets.some((offset, index) => index > 0 && offset < offsets[index - 1])) {
    warnings.push({ code: "timing_not_monotonic", message: "Times go backwards in places. File order was kept." });
  }
  return { format, turns };
}

// ------------------------------------------------------------------------------------- entry

/** Auto-detection needs SRT's comma milliseconds; a file declared .srt may use a period. */
function looksLikeSrt(text: string, declared: boolean): boolean {
  const first = splitBlocks(text)[0];
  if (!first) return false;
  const timingIndex = /^\d+$/.test(first.lines[0].trim()) ? 1 : 0;
  const timing = first.lines[timingIndex]?.trim() ?? "";
  return CUE_TIMING.test(timing) && (declared ? /\d[,.]\d{1,3}\s+-->/ : /\d,\d{1,3}\s+-->/).test(timing);
}

function isWebVtt(text: string): boolean {
  return /^WEBVTT(?:[ \t][^\n]*)?(?:\n|$)/.test(text.replace(/^\s+/, ""));
}

/**
 * Parses normalized transcript text (see normalizeTranscriptText). `formatHint` is the uploaded
 * file's extension, or null for pasted text. A .vtt or .srt file must actually contain that
 * format; a .txt/.md file or a paste that turns out to be WebVTT/SRT is parsed as such, with a
 * warning, because a subtitle file renamed to .txt is still a subtitle file.
 */
export function parseTranscriptText(text: string, options: { formatHint?: TranscriptFileFormat | null } = {}): ParsedTranscript {
  const hint = options.formatHint ?? null;
  const warnings: TranscriptImportWarning[] = [];
  const vtt = isWebVtt(text);
  const srt = !vtt && looksLikeSrt(text, hint === "srt");

  if (hint === "vtt" && !vtt) {
    throw new TranscriptImportError("content_format_mismatch", "This .vtt file does not start with a WEBVTT header.");
  }
  if (hint === "srt" && !srt) {
    throw new TranscriptImportError("content_format_mismatch", "This .srt file does not start with a numbered subtitle cue.");
  }
  if ((hint === "txt" || hint === "md" || hint === null) && (vtt || srt)) {
    warnings.push({
      code: "format_detected_from_content",
      message: `The text is a ${vtt ? "WebVTT" : "SRT"} subtitle file and was read as one.`,
      details: { detected: vtt ? "webvtt" : "srt" }
    });
  }

  let format: DetectedTranscriptFormat;
  let container: TranscriptContainer;
  let turns: ParsedTurn[];
  if (vtt) {
    format = "webvtt";
    container = "webvtt";
    turns = cueTurns(parseWebVtt(text.replace(/^\s+/, (leading) => leading.replace(/[^\n]/g, ""))), warnings);
  } else if (srt) {
    format = "srt";
    container = "srt";
    turns = cueTurns(parseSrt(text), warnings);
  } else {
    const markdown = hint === "md" || (hint === null && looksLikeMarkdown(text));
    container = markdown ? "markdown" : "text";
    const { lines, headings } = markdown ? stripMarkdown(text) : { lines: text.split("\n"), headings: new Set<number>() };
    const parsed = parseText(lines, headings, warnings);
    format = parsed.format;
    turns = parsed.turns;
  }

  turns = turns.filter((turn) => turn.text.length > 0);
  if (turns.length === 0) {
    throw new TranscriptImportError("no_transcript_content", "No transcript text was found.");
  }
  if (turns.every((turn) => turn.speaker === null)) {
    warnings.push({ code: "no_speakers_detected", message: "No speaker names were found. Every line will show as Unknown Speaker." });
  }
  return { format, container, turns, warnings };
}
