import assert from "node:assert/strict";
import test from "node:test";

import { ImportDb, USER_A, uuid } from "./fixtures/transcript-import/import-db";
import { removeDelimitedSpans, stripBoldEmphasis } from "../lib/transcript-import/emphasis";
import { handleTranscriptImport, handleTranscriptPreview } from "../lib/transcript-import/http";
import { normalizeTranscriptText } from "../lib/transcript-import/input";
import { MAX_IMPORT_SEGMENTS, MAX_TRANSCRIPT_BYTES } from "../lib/transcript-import/limits";
import { prepareTranscriptImport, type ParfaitImportPayload } from "../lib/transcript-import/prepare";

/**
 * Parsing must take time proportional to the input. Two regexes used to rescan to the end of their
 * line for every unmatched opener (`**`, `__`, `<`, `{\`), so a crafted file near the 1 MiB limit
 * kept the preview and import routes busy for minutes. These tests run the real parser on
 * adversarial input at the real size limit under a time ceiling that is far above the linear cost
 * (about 0.1 s) and far below the old cost (minutes at this size).
 */

const MB = MAX_TRANSCRIPT_BYTES - 24 * 1024; // comfortably inside the limit, with room for framing
const CEILING_MS = 5_000;

type Hint = "txt" | "md" | "vtt" | "srt" | null;
const repeatTo = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
const prepare = (text: string, hint: Hint = null) =>
  prepareTranscriptImport({ text: normalizeTranscriptText(text), source: "manual_paste", formatHint: hint });
const payload = (segment: { raw_payload: unknown }) => (segment.raw_payload as { parfait_import: ParfaitImportPayload }).parfait_import;

function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

// ------------------------------------------------------------------ equivalence with the old regexes
const REFERENCE_BOLD = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g;

function* strings(alphabet: string[], maxLength: number): Generator<string> {
  yield "";
  let current = [""];
  for (let length = 1; length <= maxLength; length += 1) {
    const next: string[] = [];
    for (const prefix of current) for (const char of alphabet) next.push(prefix + char);
    yield* next;
    current = next;
  }
}

test("emphasis stripping equals the original regex on every short string over a hostile alphabet", () => {
  let checked = 0;
  for (const text of strings(["*", "_", " ", "a", "\t"], 8)) {
    assert.equal(stripBoldEmphasis(text), text.replace(REFERENCE_BOLD, "$2"), JSON.stringify(text));
    checked += 1;
  }
  assert.ok(checked > 400_000);
});

test("emphasis stripping equals the original regex on random longer strings, including unicode whitespace", () => {
  let seed = 7;
  const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pieces = ["**", "__", "*", "_", " ", " ", "　", "a", "bc", "é", "😀", ":"];
  for (let i = 0; i < 20_000; i += 1) {
    const text = Array.from({ length: 1 + Math.floor(random() * 30) }, () => pieces[Math.floor(random() * pieces.length)]).join("");
    assert.equal(stripBoldEmphasis(text), text.replace(REFERENCE_BOLD, "$2"), JSON.stringify(text));
  }
});

test("delimited-span removal equals the original regexes on every short string over a hostile alphabet", () => {
  for (const text of strings(["<", ">", "{", "\\", "}", "\n", "a"], 7)) {
    assert.equal(removeDelimitedSpans(text, "<", ">"), text.replace(/<[^>\n]*>/g, ""), JSON.stringify(text));
    assert.equal(removeDelimitedSpans(text, "{\\", "}"), text.replace(/\{\\[^}\n]*\}/g, ""), JSON.stringify(text));
  }
});

// ------------------------------------------------------------------ valid Markdown is unchanged
const rows = (text: string, hint: Hint = "md") =>
  prepare(text, hint).segments.map((segment) => [segment.speaker, segment.text] as const);

test("bold speaker labels, underscore labels and in-line emphasis give the same speakers and text as before", () => {
  const text = [
    "# Weekly sync",
    "",
    "**Craig:** I'll finish the **prototype** Friday.",
    "",
    "__Aditya:__ I'll send the __requirements__ tomorrow.",
    "",
    "**Craig**: Sounds good.",
    "",
    "__Aditya__: Thanks."
  ].join("\n");
  assert.deepEqual(rows(text), [
    [null, "Weekly sync"],
    ["Craig", "I'll finish the prototype Friday."],
    ["Aditya", "I'll send the requirements tomorrow."],
    ["Craig", "Sounds good."],
    ["Aditya", "Thanks."]
  ]);
});

test("unmatched, repeated and mixed delimiters stay as literal text; only real pairs are removed", () => {
  assert.equal(stripBoldEmphasis("**open and never closed"), "**open and never closed");
  assert.equal(stripBoldEmphasis("never opened**"), "never opened**");
  assert.equal(stripBoldEmphasis("a ** b ** c"), "a ** b ** c", "a delimiter followed or preceded by a space never pairs");
  assert.equal(stripBoldEmphasis("**one** and **two**"), "one and two");
  assert.equal(stripBoldEmphasis("**a** ** b"), "a ** b");
  assert.equal(stripBoldEmphasis("****"), "****");
  assert.equal(stripBoldEmphasis("**a**b**c**"), "ab**c**".replace("**c**", "c"), "pairs resume after each closer");
  assert.equal(stripBoldEmphasis("__a__ **b** __c"), "a b __c");
  assert.equal(stripBoldEmphasis("**a __b** c__"), "a __b c__", "a pair never closes on the other delimiter");
  assert.equal(stripBoldEmphasis("plain text"), "plain text");
  assert.equal(stripBoldEmphasis(""), "");
});

test("a multiline Markdown transcript keeps every turn, in order, with its speaker", () => {
  const turns = Array.from({ length: 40 }, (_, i) => `**${i % 2 ? "Jordan" : "Alex"}:** turn ${i} with **emphasis** and a lone ** marker`);
  const prepared = prepare(turns.join("\n\n"), "md");
  assert.equal(prepared.segments.length, 40);
  prepared.segments.forEach((segment, i) => {
    assert.equal(segment.speaker, i % 2 ? "Jordan" : "Alex");
    assert.equal(segment.text, `turn ${i} with emphasis and a lone ** marker`);
    assert.equal(payload(segment).segment_index, i);
  });
  assert.equal(prepared.format, "speaker_labeled");
  assert.deepEqual(prepared.speakers, [{ label: "Alex", segmentCount: 20 }, { label: "Jordan", segmentCount: 20 }]);
  assert.deepEqual(prepared.warnings, []);
});

test("subtitle markup is still removed exactly as before", () => {
  const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Craig>I'll <i>finish</i> it {\\an8}Friday <00:00:01.500>&amp; test.\n\n00:00:03.000 --> 00:00:04.000\nUnclosed < angle and {\\ brace\n";
  assert.deepEqual(rows(vtt, "vtt"), [["Craig", "I'll finish it Friday & test."], [null, "Unclosed < angle and {\\ brace"]]);
});

// ------------------------------------------------------------------ hostile input at the size limit
const HOSTILE: Array<[string, () => { text: string; hint: Hint }]> = [
  ["markdown: ** openers, no closers", () => ({ text: "**Alex:** x\n**Jordan:** y\n" + repeatTo("**x ", MB), hint: "md" })],
  ["markdown: __ openers, no closers", () => ({ text: "__Alex:__ x\n__Jordan:__ y\n" + repeatTo("__x ", MB), hint: "md" })],
  ["markdown: mixed ** and __ openers", () => ({ text: "**Alex:** x\n**Jordan:** y\n" + repeatTo("**a __b ", MB), hint: "md" })],
  ["markdown: one unbroken run of asterisks", () => ({ text: "**Alex:** x\n**Jordan:** y\n" + "*".repeat(MB), hint: "md" })],
  ["markdown: openers with a closer only at the very end", () => ({ text: "**Alex:** x\n**Jordan:** y\n" + repeatTo("**x ", MB) + "x**", hint: "md" })],
  ["markdown detected from a paste", () => ({ text: "**Alex:** x\n\n**Jordan:** y\n\n" + repeatTo("__x ", MB), hint: null })],
  ["WebVTT: unclosed '<' tags in one cue", () => ({ text: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n" + repeatTo("<b ", MB), hint: "vtt" })],
  ["WebVTT: unclosed '{\\' overrides in one cue", () => ({ text: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n" + repeatTo("{\\an ", MB), hint: "vtt" })],
  ["SRT: unclosed '<' tags in one cue", () => ({ text: "1\n00:00:01,000 --> 00:00:02,000\n" + repeatTo("<i ", MB), hint: "srt" })],
  ["WebVTT: unclosed tags spread over many lines", () => ({ text: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n" + repeatTo("<b <b <b <b\n", MB), hint: "vtt" })],
  ["plain text: one line, no spaces", () => ({ text: "a".repeat(MB), hint: null })],
  ["plain text: one line of 'Name: ' labels", () => ({ text: repeatTo("Ab: ", MB), hint: null })],
  ["plain text: one line of time brackets", () => ({ text: repeatTo("[00:01] ", MB), hint: null })],
  ["plain text: one line of dashes and spaces", () => ({ text: repeatTo("- ", MB) + "x", hint: "md" })],
  ["plain text: 170k one-word turns (over the segment cap)", () => ({ text: repeatTo("Al: x\n", MB), hint: null })]
];

for (const [name, build] of HOSTILE) {
  test(`hostile input near the 1 MiB limit parses in bounded time: ${name}`, () => {
    const { text, hint } = build();
    assert.ok(Buffer.byteLength(text) <= MAX_TRANSCRIPT_BYTES, "input stays within the real size limit");
    const { value, ms } = timed(() => {
      try {
        return prepare(text, hint);
      } catch (error) {
        return error as { code?: string };
      }
    });
    assert.ok(ms < CEILING_MS, `${name} took ${ms.toFixed(0)} ms (ceiling ${CEILING_MS} ms)`);
    // Whatever the verdict, it is a real one: parsed segments or a deliberate, coded refusal.
    assert.ok("segments" in value || typeof (value as { code?: string }).code === "string");
  });
}

test("runtime grows in proportion to size, not with its square (unmatched ** openers)", () => {
  const measure = (bytes: number) => {
    const text = "**Alex:** x\n**Jordan:** y\n" + repeatTo("**x ", bytes);
    let best = Infinity;
    for (let i = 0; i < 3; i += 1) best = Math.min(best, timed(() => prepare(text, "md")).ms);
    return Math.max(best, 5); // a floor, so timer noise on tiny runs cannot inflate the ratio
  };
  const small = measure(120 * 1024);
  const large = measure(MB);
  // 8.3x the input. Linear is about 8x; the old quadratic code was about 70x (and minutes in absolute terms).
  assert.ok(large / small < 30, `8.3x more input took ${(large / small).toFixed(1)}x longer (${small.toFixed(0)} ms -> ${large.toFixed(0)} ms)`);
});

// ------------------------------------------------------------------ limits are untouched
test("the 1 MiB limit and the segment cap still apply, and the largest valid transcript still imports in full", () => {
  assert.throws(() => normalizeTranscriptText("a".repeat(MAX_TRANSCRIPT_BYTES + 1)), (e: { code?: string }) => e.code === "input_too_large");
  assert.ok(MAX_IMPORT_SEGMENTS === 20_000 && MAX_TRANSCRIPT_BYTES === 1024 * 1024);

  const line = (i: number) => `**${i % 3 === 0 ? "Alex" : i % 3 === 1 ? "Jordan" : "Sam"}:** line ${String(i).padStart(6, "0")} ${"word ".repeat(9)}`;
  const turns = Math.floor((MB - 2) / (Buffer.byteLength(line(0)) + 2));
  const text = Array.from({ length: turns }, (_, i) => line(i)).join("\n\n");
  assert.ok(turns < MAX_IMPORT_SEGMENTS && Buffer.byteLength(text) > 900 * 1024, "a realistic near-maximum transcript");
  const { value, ms } = timed(() => prepare(text, "md"));
  assert.ok(ms < CEILING_MS);
  assert.equal(value.segments.length, turns, "every turn is kept: nothing is truncated");
  assert.equal(value.segments[0].speaker, "Alex");
  assert.equal(value.segments.at(-1)!.text.startsWith(`line ${String(turns - 1).padStart(6, "0")}`), true);
  assert.deepEqual(value.segments.map((s) => payload(s).segment_index), value.segments.map((_, i) => i));

  assert.throws(() => prepare(repeatTo("Al: x\n", MB), null), (e: { code?: string }) => e.code === "too_many_segments");
});

// ------------------------------------------------------------------ both routes use the corrected parser
function jsonRequest(path: string, body: Record<string, unknown>) {
  return new Request(`http://localhost/api/meetings/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": USER_A },
    body: JSON.stringify(body)
  });
}
const auth = (request: Request) => async () => ({ user: { id: request.headers.get("x-test-user")! }, response: null });

test("the preview route handles hostile Markdown quickly and writes nothing", async () => {
  const request = jsonRequest("import/preview", { text: "**Alex:** x\n**Jordan:** y\n" + repeatTo("**x ", MB), format: "md" });
  const { value: response, ms } = await (async () => {
    const start = performance.now();
    const value = await handleTranscriptPreview(request, { requireUser: auth(request) });
    return { value, ms: performance.now() - start };
  })();
  assert.ok(ms < CEILING_MS, `preview took ${ms.toFixed(0)} ms`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { preview: { segmentCount: number; speakers: Array<{ label: string }> } };
  assert.ok(body.preview.segmentCount > 0);
  assert.deepEqual(body.preview.speakers.map((s) => s.label), ["Alex", "Jordan"]);
});

test("the import route handles hostile Markdown and VTT quickly through the same parser", async () => {
  for (const [id, text, format] of [
    [1, "**Alex:** x\n**Jordan:** y\n" + repeatTo("__x ", MB), "md"],
    [2, "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n" + repeatTo("<b ", MB), "vtt"]
  ] as const) {
    const db = new ImportDb();
    const request = jsonRequest("import", { importId: uuid(id), text, format });
    const start = performance.now();
    const response = await handleTranscriptImport(request, { requireUser: auth(request), importDeps: db.deps() });
    const ms = performance.now() - start;
    assert.ok(ms < CEILING_MS, `import ${format} took ${ms.toFixed(0)} ms`);
    assert.equal(response.status, 201);
    assert.ok(db.segments.get(uuid(id))!.length > 0);
    assert.deepEqual(db.enqueueCalls, [uuid(id)], "behaviour after parsing is unchanged: one meeting, one analysis");
  }
});

test("there is a single parsing path: both routes reach the parser only through prepareTranscriptImport", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const http = await read("lib/transcript-import/http.ts");
  assert.equal((http.match(/prepareTranscriptImport\(/g) ?? []).length, 2, "preview and import, nothing else");
  assert.doesNotMatch(http, /parseTranscriptText|stripMarkdown|stripCueMarkup|\.replace\(/);
  for (const route of ["app/api/meetings/import/route.ts", "app/api/meetings/import/preview/route.ts"]) {
    assert.doesNotMatch(await read(route), /parse|prepareTranscriptImport|\.replace\(/, route);
  }
  const parser = await read("lib/transcript-import/parse.ts");
  assert.doesNotMatch(parser, /\(\.\+\?\)/, "no lazy any-character group left in the parser");
  assert.match(parser, /stripBoldEmphasis\(out\)/);
  assert.match(parser, /removeDelimitedSpans\(/);
  assert.doesNotMatch(parser, /\/<\[\^>\\n\]\*>\/g|\/\\\{\\\\\[\^\}\\n\]\*\\\}\/g/, "the unbounded tag regexes are gone");
});
