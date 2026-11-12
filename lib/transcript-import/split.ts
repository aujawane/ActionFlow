import { MAX_SEGMENT_CHARS } from "@/lib/transcript-import/limits";

/**
 * Deterministic splitting of one long turn into segments of at most `max` characters.
 *
 * - Text at or under the limit is returned unchanged, as a single piece.
 * - Otherwise the text is cut at sentence ends first (. ! ? … optionally followed by a closing
 *   quote or bracket), and sentences are packed greedily so each piece is as full as possible.
 * - A single sentence longer than the limit is cut at clause punctuation (, ; : — –), then at
 *   spaces, and only a single "word" longer than the limit (a pasted URL, say) is cut mid-token.
 * - Nothing is dropped or reworded: joining the pieces with single spaces reproduces the input
 *   exactly, except in the mid-token case, which reports itself through `hardSplit`.
 *
 * Every step works on a finite array that strictly shrinks, so there is no loop that can fail to
 * terminate on an unusual input.
 */
export type SplitResult = { pieces: string[]; hardSplit: boolean };

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const CLAUSE_END = /[,;:—–]["'”’)\]]*$/;

/** Words of `text` (single-space separated), grouped into units that end where `endsUnit` says. */
function unitsEndingWhere(text: string, endsUnit: RegExp): string[] {
  const words = text.split(" ");
  const units: string[] = [];
  let current: string[] = [];
  for (const word of words) {
    current.push(word);
    if (endsUnit.test(word)) {
      units.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) units.push(current.join(" "));
  return units;
}

function hardCut(word: string, max: number): string[] {
  const codePoints = Array.from(word); // never cut a surrogate pair in half
  const pieces: string[] = [];
  for (let start = 0; start < codePoints.length; start += max) {
    pieces.push(codePoints.slice(start, start + max).join(""));
  }
  return pieces;
}

type Level = "sentence" | "clause" | "word";

function split(text: string, max: number, level: Level, state: { hardSplit: boolean }): string[] {
  if (text.length <= max) return [text];
  const units =
    level === "sentence"
      ? unitsEndingWhere(text, SENTENCE_END)
      : level === "clause"
        ? unitsEndingWhere(text, CLAUSE_END)
        : text.split(" ");

  const pieces: string[] = [];
  let current = "";
  const flush = () => {
    if (current) pieces.push(current);
    current = "";
  };
  for (const unit of units) {
    if (unit.length > max) {
      flush();
      if (level === "sentence") pieces.push(...split(unit, max, "clause", state));
      else if (level === "clause") pieces.push(...split(unit, max, "word", state));
      else {
        state.hardSplit = true;
        pieces.push(...hardCut(unit, max));
      }
      continue;
    }
    if (!current) current = unit;
    else if (current.length + 1 + unit.length <= max) current += ` ${unit}`;
    else {
      flush();
      current = unit;
    }
  }
  flush();
  return pieces;
}

/** `text` must already be whitespace-normalized (single spaces, trimmed). */
export function splitSegmentText(text: string, max: number = MAX_SEGMENT_CHARS): SplitResult {
  if (!Number.isSafeInteger(max) || max < 1) throw new Error(`Invalid segment limit: ${max}`);
  const state = { hardSplit: false };
  const pieces = split(text, max, "sentence", state).filter((piece) => piece.length > 0);
  return { pieces, hardSplit: state.hardSplit };
}

/** Collapses every whitespace run (including newlines) to one space and trims. Words and
 * punctuation are untouched; the analysis prompt builders already collapse whitespace the same way. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
