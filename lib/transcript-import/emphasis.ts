/**
 * Bold-emphasis stripping for Markdown transcript lines, in linear time.
 *
 * This replaces `line.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")`. That regex was quadratic:
 * for every opener with no closer later on the line, the lazy `.+?` scanned to the end of the line
 * before giving up, and the engine then retried from the next character. A 1 MiB line of
 * unmatched `**` therefore cost minutes of CPU.
 *
 * The behaviour is identical, and a differential test checks it against the original regex:
 *   - an opener is `**` or `__` immediately followed by a non-whitespace character;
 *   - its closer is the nearest later occurrence of the same two characters (starting at least one
 *     character after the opener, so the content is non-empty) that is immediately preceded by a
 *     non-whitespace character;
 *   - the pair is replaced by its content, and scanning resumes after the closer;
 *   - an opener with no closer is left as literal text and scanning moves on one character.
 *
 * It works on UTF-16 code units, like the regex did without the `u` flag.
 *
 * Why it is linear: for each delimiter the positions that could close a pair are collected once
 * (one pass), and the scan only ever moves forward through that list, so no character is examined
 * more than a constant number of times.
 */

const DELIMITERS = ["**", "__"] as const;
const NON_WHITESPACE = /\S/;

function isNonWhitespace(char: string): boolean {
  return char !== "" && NON_WHITESPACE.test(char);
}

/** Positions where `delimiter` starts and the previous character is non-whitespace: the only
 * positions that can close a pair. Ascending. */
function closerPositions(line: string, delimiter: string): number[] {
  const positions: number[] = [];
  let from = line.indexOf(delimiter);
  while (from !== -1) {
    if (from > 0 && isNonWhitespace(line[from - 1])) positions.push(from);
    from = line.indexOf(delimiter, from + 1);
  }
  return positions;
}

export function stripBoldEmphasis(line: string): string {
  // Cheap exit for the overwhelmingly common line with no emphasis markers at all.
  if (!line.includes("**") && !line.includes("__")) return line;

  const closers = DELIMITERS.map((delimiter) => ({ delimiter, positions: closerPositions(line, delimiter), next: 0 }));

  let output = "";
  let literalFrom = 0; // start of the pending run of unmodified text
  let index = 0;
  while (index < line.length - 1) {
    const first = line[index];
    const candidate =
      (first === "*" || first === "_") && line[index + 1] === first
        ? closers[first === "*" ? 0 : 1]
        : undefined;
    if (!candidate || !isNonWhitespace(line.charAt(index + 2))) {
      index += 1;
      continue;
    }
    // The nearest closer that leaves at least one character of content. `next` only moves forward
    // because `index` only does.
    while (candidate.next < candidate.positions.length && candidate.positions[candidate.next] < index + 3) {
      candidate.next += 1;
    }
    const closer = candidate.positions[candidate.next];
    if (closer === undefined) {
      index += 1;
      continue;
    }
    output += line.slice(literalFrom, index) + line.slice(index + 2, closer);
    index = closer + 2;
    literalFrom = index;
  }
  return output + line.slice(literalFrom);
}

/**
 * Removes every `open ... close` span where the span's body contains no `close` and no newline, in
 * linear time. Replaces `/<[^>\n]*>/g` and `/\{\\[^}\n]*\}/g`, which rescanned to the end of the text
 * for every opener that had no closer (quadratic on a long run of unclosed `<`).
 *
 * Identical matching to those regexes: left to right, an opener pairs with the FIRST closing
 * character after it, provided no newline comes first; otherwise that opener is literal text.
 * Why it is linear: when an opener fails, every other opener before the same stopping point fails
 * for the same reason, so the scan resumes after that point instead of retrying each one.
 */
export function removeDelimitedSpans(text: string, open: string, close: string): string {
  let output = "";
  let literalFrom = 0;
  let index = text.indexOf(open);
  while (index !== -1) {
    const bodyStart = index + open.length;
    let stop = bodyStart;
    while (stop < text.length && text[stop] !== close && text[stop] !== "\n") stop += 1;
    if (stop >= text.length) break; // no closer or newline until the end: no later opener can match
    if (text[stop] === close) {
      output += text.slice(literalFrom, index);
      literalFrom = stop + 1;
      index = text.indexOf(open, literalFrom);
    } else {
      index = text.indexOf(open, stop + 1); // newline: openers before it cannot match either
    }
  }
  return output + text.slice(literalFrom);
}
