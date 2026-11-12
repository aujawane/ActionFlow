import assert from "node:assert/strict";
import test from "node:test";

import { TranscriptImportError } from "../lib/transcript-import/errors";
import { decodeTranscriptBytes, formatFromFileName, normalizeTranscriptText } from "../lib/transcript-import/input";
import { CUE_MERGE_TARGET_CHARS, MAX_IMPORT_SEGMENTS, MAX_SEGMENT_CHARS, MAX_TRANSCRIPT_BYTES } from "../lib/transcript-import/limits";
import { classifySpeakerLabel, parseClockOffset, parseTranscriptText } from "../lib/transcript-import/parse";
import { buildTranscriptImportPreview, prepareTranscriptImport, type ParfaitImportPayload } from "../lib/transcript-import/prepare";
import { splitSegmentText } from "../lib/transcript-import/split";
import { canonicalTranscriptOrder } from "../lib/transcript-order";

const encode = (text: string) => new TextEncoder().encode(text);

function prepare(text: string, formatHint: "txt" | "md" | "vtt" | "srt" | null = null) {
  return prepareTranscriptImport({ text: normalizeTranscriptText(text), source: "manual_paste", formatHint });
}
function rows(text: string, formatHint: "txt" | "md" | "vtt" | "srt" | null = null) {
  return prepare(text, formatHint).segments.map((segment) => ({
    speaker: segment.speaker,
    text: segment.text,
    offset: payloadOf(segment).start_offset_ms ?? null
  }));
}
function payloadOf(segment: { raw_payload: unknown }): ParfaitImportPayload {
  return (segment.raw_payload as { parfait_import: ParfaitImportPayload }).parfait_import;
}
function rejects(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => error instanceof TranscriptImportError && error.code === code, `expected ${code}`);
}

// ------------------------------------------------------------------ speaker-prefixed text
test("speaker-prefixed lines become one turn per line with the explicit names", () => {
  assert.deepEqual(
    rows("Craig: I'll finish the prototype Friday.\nAditya: I'll send the requirements tomorrow.\nCraig: Let's review Monday."),
    [
      { speaker: "Craig", text: "I'll finish the prototype Friday.", offset: null },
      { speaker: "Aditya", text: "I'll send the requirements tomorrow.", offset: null },
      { speaker: "Craig", text: "Let's review Monday.", offset: null }
    ]
  );
  assert.equal(prepare("Craig: a\nAditya: b").format, "speaker_labeled");
});

test("multiline speaker blocks keep every continuation line in the speaker's turn", () => {
  const text = "Craig:\nI'll finish the prototype.\nThen I'll demo it.\n\nAditya:\nSounds good.\nAlso the docs.\n\nMore from Aditya after a blank line.";
  assert.deepEqual(rows(text), [
    { speaker: "Craig", text: "I'll finish the prototype. Then I'll demo it.", offset: null },
    { speaker: "Aditya", text: "Sounds good. Also the docs. More from Aditya after a blank line.", offset: null }
  ]);
});

test("names with titles, particles, hyphens, apostrophes, qualifiers and non-Latin scripts are accepted", () => {
  for (const name of ["Dr. Smith", "Jean-Luc Picard", "Seán O'Brien", "Ludwig van Beethoven", "Craig (PM)", "Speaker 1", "李雷", "Interviewer"]) {
    assert.deepEqual(classifySpeakerLabel(name), { kind: "speaker", name }, name);
  }
});

// ------------------------------------------------------------------ false speaker labels
test("headings and note fields are never treated as speakers", () => {
  for (const label of ["Action item", "Action Items", "Note", "Notes", "Next steps", "Decision", "Agenda", "Summary", "Q", "TODO", "Key Points", "Budget", "Follow-up"]) {
    assert.deepEqual(classifySpeakerLabel(label), { kind: "not_a_name" }, label);
  }
  for (const label of ["we decided", "the plan", "It was agreed that we", "10", "a very long label that is clearly a sentence and not a name at all"]) {
    assert.deepEqual(classifySpeakerLabel(label), { kind: "not_a_name" }, label);
  }
});

test("an 'Action item:' line inside a speaker's turn stays in that turn as text", () => {
  const out = rows("Craig: I'll finish the prototype.\nAction item: send the deck.\nAditya: Great.\nNote: due Friday.");
  assert.deepEqual(out, [
    { speaker: "Craig", text: "I'll finish the prototype. Action item: send the deck.", offset: null },
    { speaker: "Aditya", text: "Great. Note: due Friday.", offset: null }
  ]);
});

test("prose with a couple of 'Word: text' lines is not read as dialogue", () => {
  const text = [
    "We met to plan the launch and went through the open issues one by one.",
    "",
    "Marketing wants a date before the conference, engineering wants another week.",
    "",
    "Paris: the venue is booked.",
    "",
    "The team agreed to revisit on Monday after the numbers come in.",
    "",
    "Overall it was a productive session with clear owners.",
    "",
    "Berlin: still waiting on the contract.",
    "",
    "We will reconvene next week."
  ].join("\n");
  const prepared = prepare(text);
  assert.equal(prepared.format, "plain_text");
  assert.ok(prepared.segments.every((segment) => segment.speaker === null));
  assert.ok(prepared.segments.some((segment) => segment.text === "Paris: the venue is booked."), "label text kept verbatim");
  assert.ok(prepared.warnings.some((warning) => warning.code === "speaker_labels_not_trusted"));
});

test("URLs and clock times are not speaker labels", () => {
  const prepared = prepare("See https://example.com/doc for details.\nWe start at 10:30 sharp.\nhttp://foo.bar is down.");
  assert.equal(prepared.format, "plain_text");
  assert.ok(prepared.segments.every((segment) => segment.speaker === null));
});

// ------------------------------------------------------------------ unknown speakers
test("explicit unknown labels start a turn with no speaker, never an invented name", () => {
  const out = rows("Craig: Hello.\nUnknown Speaker: Who joined?\nCraig: Welcome.\nSpeaker: Thanks.");
  assert.deepEqual(out.map((row) => row.speaker), ["Craig", null, "Craig", null]);
});

test("plain paragraphs have no speakers and warn about it", () => {
  const prepared = prepare("First paragraph line one.\nline two.\n\nSecond paragraph.");
  assert.equal(prepared.format, "plain_text");
  assert.deepEqual(prepared.segments.map((segment) => [segment.speaker, segment.text]), [
    [null, "First paragraph line one. line two."],
    [null, "Second paragraph."]
  ]);
  assert.ok(prepared.warnings.some((warning) => warning.code === "no_speakers_detected"));
});

test("a preamble before the first speaker is kept as unknown-speaker text", () => {
  const out = rows("Weekly sync, August 19\n\nCraig: Let's start.\nAditya: Ready.\nCraig: Good.");
  assert.deepEqual(out[0], { speaker: null, text: "Weekly sync, August 19", offset: null });
  assert.equal(out[1].speaker, "Craig");
});

// ------------------------------------------------------------------ timestamped blocks
test("timestamped speaker blocks keep relative offsets in milliseconds, never dates", () => {
  const prepared = prepare("[00:02:13] Craig\nI'll finish the prototype Friday.\n\n[00:02:18] Aditya\nI'll send the requirements tomorrow.");
  assert.equal(prepared.format, "timestamped_speaker_blocks");
  assert.equal(prepared.hasTimeOffsets, true);
  assert.deepEqual(rows("[00:02:13] Craig\nI'll finish the prototype Friday.\n\n[00:02:18] Aditya\nI'll send the requirements tomorrow."), [
    { speaker: "Craig", text: "I'll finish the prototype Friday.", offset: 133_000 },
    { speaker: "Aditya", text: "I'll send the requirements tomorrow.", offset: 138_000 }
  ]);
  assert.ok(prepared.segments.every((segment) => segment.timestamp === null));
  assert.ok(!JSON.stringify(prepared.segments).includes("1970"));
});

test("other timestamp styles: inline, name-then-time, and bracketed time-only lines", () => {
  assert.deepEqual(rows("[00:01] Craig: Hello there.\n[00:05] Aditya: Hi."), [
    { speaker: "Craig", text: "Hello there.", offset: 1000 },
    { speaker: "Aditya", text: "Hi.", offset: 5000 }
  ]);
  assert.deepEqual(rows("Craig Smith  0:02\nHello there.\n\nAditya  1:15\nHi."), [
    { speaker: "Craig Smith", text: "Hello there.", offset: 2000 },
    { speaker: "Aditya", text: "Hi.", offset: 75_000 }
  ]);
  assert.deepEqual(rows("[00:00:01] Welcome everyone.\n[00:00:09] Thanks Craig"), [
    { speaker: null, text: "Welcome everyone.", offset: 1000 },
    // "Thanks Craig" has nothing after it, so it is speech, not a speaker header.
    { speaker: null, text: "Thanks Craig", offset: 9000 }
  ]);
});

test("clock offsets parse strictly", () => {
  assert.equal(parseClockOffset("1:02:03"), 3_723_000);
  assert.equal(parseClockOffset("02:03.5"), 123_500);
  assert.equal(parseClockOffset("00:02:13,250"), 133_250);
  assert.equal(parseClockOffset("00:61"), null);
  assert.equal(parseClockOffset("1:75:00"), null);
  assert.equal(parseClockOffset("abc"), null);
});

test("no timestamps: offsets absent and hasTimeOffsets false", () => {
  const prepared = prepare("Craig: a\nAditya: b");
  assert.equal(prepared.hasTimeOffsets, false);
  assert.ok(prepared.segments.every((segment) => payloadOf(segment).start_offset_ms === undefined));
});

test("times that go backwards keep file order and warn", () => {
  const prepared = prepare("[00:05] Craig: second?\n[00:01] Aditya: first?");
  assert.deepEqual(prepared.segments.map((segment) => segment.speaker), ["Craig", "Aditya"]);
  assert.ok(prepared.warnings.some((warning) => warning.code === "timing_not_monotonic"));
});

// ------------------------------------------------------------------ markdown
test("markdown: headings, bold speaker labels, bullets and emphasis are cleaned without changing words", () => {
  const md = "---\ntitle: Sync\n---\n# Weekly sync\n\n**Craig:** I'll finish the *prototype*.\n\n**Aditya**: Action item: send **requirements**.\n\n- **Craig:** ok\n\n---\n\n> Aditya: quoted reply";
  const prepared = prepare(md, "md");
  assert.equal(prepared.container, "markdown");
  assert.deepEqual(prepared.segments.map((segment) => [segment.speaker, segment.text]), [
    [null, "Weekly sync"],
    ["Craig", "I'll finish the *prototype*."],
    ["Aditya", "Action item: send requirements."],
    ["Craig", "ok"],
    ["Aditya", "quoted reply"]
  ]);
});

test("a markdown heading that looks like a name is not a speaker", () => {
  const prepared = prepare("## Craig\n\nCraig: hello\nAditya: hi\nCraig: bye", "md");
  assert.deepEqual(prepared.segments[0], { ...prepared.segments[0], speaker: null, text: "Craig" });
});

test("pasted markdown is recognized from bold speaker labels", () => {
  assert.equal(prepare("**Craig:** hi\n\n**Aditya:** hello").container, "markdown");
  assert.equal(prepare("Craig: hi\nAditya: hello").container, "text");
});

// ------------------------------------------------------------------ WebVTT
const VTT = [
  "WEBVTT Kind: captions",
  "Language: en",
  "",
  "NOTE exported by a meeting tool",
  "spanning two lines",
  "",
  "STYLE",
  "::cue { color: white }",
  "",
  "intro-1",
  "00:00:01.000 --> 00:00:03.000 align:start",
  "<v Craig>I'll finish</v>",
  "",
  "00:00:03.500 --> 00:00:05.000",
  "<v Craig>the <i>prototype</i> Friday &amp; demo.",
  "",
  "00:00:06.000 --> 00:00:08.000",
  "<v.loud Aditya Rao>Sure.</v>",
  "",
  "00:00:09.000 --> 00:00:09.500",
  "",
  "1:00:10.000 --> 1:00:12.000",
  "<c.yellow>No voice tag here.</c>"
].join("\n");

test("WebVTT: voice tags give speakers, NOTE/STYLE skipped, markup and entities removed, cues merged", () => {
  const prepared = prepare(VTT, "vtt");
  assert.equal(prepared.format, "webvtt");
  assert.deepEqual(rows(VTT, "vtt"), [
    { speaker: "Craig", text: "I'll finish the prototype Friday & demo.", offset: 1000 },
    { speaker: "Aditya Rao", text: "Sure.", offset: 6000 },
    { speaker: null, text: "No voice tag here.", offset: 3_610_000 }
  ]);
  const first = payloadOf(prepared.segments[0]);
  assert.deepEqual([first.cue_start, first.cue_end, first.end_offset_ms], [1, 2, 5000]);
});

test("WebVTT: 'Name: text' payloads (Zoom style) become speakers with enough evidence", () => {
  const zoom = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nCraig: Hello.\n\n2\n00:00:03.000 --> 00:00:04.000\nAditya: Hi.\n\n3\n00:00:05.000 --> 00:00:06.000\nCraig: Bye.";
  assert.deepEqual(rows(zoom, "vtt").map((row) => [row.speaker, row.text]), [["Craig", "Hello."], ["Aditya", "Hi."], ["Craig", "Bye."]]);
});

test("WebVTT: consecutive same-speaker cues merge only up to the merge target", () => {
  const long = "x".repeat(300);
  const vtt = ["WEBVTT", "", "00:00:01.000 --> 00:00:02.000", `<v A>${long}`, "", "00:00:02.000 --> 00:00:03.000", `<v A>${long}`].join("\n");
  const prepared = prepare(vtt, "vtt");
  assert.equal(prepared.segments.length, 2);
  assert.ok(prepared.segments.every((segment) => segment.text.length <= CUE_MERGE_TARGET_CHARS));
});

test("WebVTT: malformed cues are rejected with the line number", () => {
  for (const [body, line] of [
    ["WEBVTT\n\n00:00:01.000 --> nonsense\nText", 3],
    ["WEBVTT\n\n00:01.000 -> 00:02.000\nText", 3],
    ["WEBVTT\n\nJust a stray paragraph", 3],
    ["WEBVTT\n\n00:00:05.000 --> 00:00:01.000\nEnds before it starts", 3]
  ] as const) {
    assert.throws(
      () => prepare(body, "vtt"),
      (error: unknown) => error instanceof TranscriptImportError && error.code === "malformed_cue" && error.details?.line === line,
      body
    );
  }
});

test("a .vtt file without a WEBVTT header is a content/format mismatch", () => {
  rejects(() => prepare("Craig: hi\nAditya: hello", "vtt"), "content_format_mismatch");
});

// ------------------------------------------------------------------ SRT
const SRT = "1\n00:00:01,000 --> 00:00:03,000\nCraig: I'll finish the <i>prototype</i>.\n\n2\n00:00:04,000 --> 00:00:06,000\nAditya: Great.\n\n3\n00:00:07,000 --> 00:00:08,000\n{\\an8}Craig: Thanks.\n";

test("SRT: numbered cues with timing and speaker prefixes", () => {
  const prepared = prepare(SRT, "srt");
  assert.equal(prepared.format, "srt");
  assert.deepEqual(rows(SRT, "srt"), [
    { speaker: "Craig", text: "I'll finish the prototype.", offset: 1000 },
    { speaker: "Aditya", text: "Great.", offset: 4000 },
    { speaker: "Craig", text: "Thanks.", offset: 7000 }
  ]);
});

test("SRT: cues without speakers merge into unknown-speaker turns", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello and\n\n2\n00:00:02,000 --> 00:00:03,000\nwelcome back.\n";
  assert.deepEqual(rows(srt, "srt"), [{ speaker: null, text: "Hello and welcome back.", offset: 1000 }]);
});

test("SRT: malformed timing is rejected; a .srt file that is not SRT is a mismatch", () => {
  rejects(() => prepare("1\n00:00:01,000 --> 00:00:03,000\nok\n\n2\n00:00:0x,000 --> 00:00:06,000\nbad", "srt"), "malformed_cue");
  rejects(() => prepare("1\n00:00:01,000 --> 00:00:03,000\nok\n\n2\nno timing here", "srt"), "malformed_cue");
  rejects(() => prepare("Craig: hello", "srt"), "content_format_mismatch");
});

test("subtitle content pasted or saved as .txt is detected and parsed as subtitles", () => {
  for (const hint of [null, "txt"] as const) {
    const prepared = prepare(SRT, hint);
    assert.equal(prepared.format, "srt");
    assert.ok(prepared.warnings.some((warning) => warning.code === "format_detected_from_content"));
  }
  assert.equal(prepare(VTT, null).format, "webvtt");
});

// ------------------------------------------------------------------ CRLF and BOM
test("CRLF, CR and a UTF-8 BOM parse identically to LF", () => {
  const lf = "Craig: I'll finish.\nAditya: Thanks.\n";
  const reference = prepare(lf).segments.map((segment) => [segment.speaker, segment.text]);
  for (const variant of [lf.replace(/\n/g, "\r\n"), lf.replace(/\n/g, "\r"), `﻿${lf.replace(/\n/g, "\r\n")}`]) {
    assert.deepEqual(prepare(variant).segments.map((segment) => [segment.speaker, segment.text]), reference);
  }
  const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode("WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\n<v A>Hi\r\n")]);
  const fromFile = prepareTranscriptImport({ text: decodeTranscriptBytes(bomBytes), source: "manual_upload", formatHint: "vtt" });
  assert.deepEqual(fromFile.segments.map((segment) => [segment.speaker, segment.text]), [["A", "Hi"]]);
});

// ------------------------------------------------------------------ input validation
test("empty and whitespace-only input is rejected", () => {
  rejects(() => normalizeTranscriptText(""), "empty_input");
  rejects(() => normalizeTranscriptText(" \n\t\r\n "), "empty_input");
  rejects(() => decodeTranscriptBytes(new Uint8Array()), "empty_input");
  rejects(() => prepare("WEBVTT\n\nNOTE only a note"), "no_transcript_content");
});

test("unsupported file types are rejected by extension", () => {
  for (const name of ["meeting.pdf", "meeting.docx", "meeting.mp3", "meeting.mp4", "meeting", "meeting.txt.exe"]) {
    rejects(() => formatFromFileName(name), "unsupported_format");
  }
  assert.equal(formatFromFileName("Q3 sync.VTT"), "vtt");
  assert.equal(formatFromFileName("notes.md"), "md");
});

test("binary content is rejected even with a text extension", () => {
  rejects(() => decodeTranscriptBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])), "binary_content"); // %PDF-1
  rejects(() => decodeTranscriptBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2])), "binary_content"); // zip/docx
  rejects(() => decodeTranscriptBytes(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])), "binary_content"); // mp4
  rejects(() => decodeTranscriptBytes(encode("hello\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u000b\u000e\u000f world")), "binary_content");
});

test("malformed UTF-8, UTF-16 and NUL bytes are rejected", () => {
  rejects(() => decodeTranscriptBytes(new Uint8Array([0x48, 0x69, 0xc3, 0x28])), "invalid_utf8");
  rejects(() => decodeTranscriptBytes(new Uint8Array([0xff, 0xfe, 0x48, 0x00])), "invalid_utf8");
  rejects(() => decodeTranscriptBytes(encode("Craig: hi\u0000there")), "nul_byte");
  rejects(() => normalizeTranscriptText("Craig: hi\u0000"), "nul_byte");
  rejects(() => normalizeTranscriptText("lone surrogate \uD800 here"), "invalid_utf8");
});

test("oversized input is rejected, at the byte limit it is accepted", () => {
  const atLimit = "a".repeat(MAX_TRANSCRIPT_BYTES);
  assert.equal(decodeTranscriptBytes(encode(atLimit)).length, MAX_TRANSCRIPT_BYTES);
  rejects(() => decodeTranscriptBytes(encode(`${atLimit}a`)), "input_too_large");
  rejects(() => normalizeTranscriptText(`${atLimit}a`), "input_too_large");
  // Multi-byte characters count as bytes, not characters.
  rejects(() => normalizeTranscriptText("é".repeat(MAX_TRANSCRIPT_BYTES / 2 + 1)), "input_too_large");
});

test("a pathological input is rejected explicitly, never truncated", () => {
  const lines = Array.from({ length: MAX_IMPORT_SEGMENTS + 1 }, (_, i) => `[${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}] w${i}`);
  rejects(() => prepare(lines.join("\n")), "too_many_segments");
});

// ------------------------------------------------------------------ long paragraphs
test("text at or under the segment limit is never split", () => {
  const exact = `${"abcd ".repeat(139)}abcde`;
  assert.equal(exact.length, MAX_SEGMENT_CHARS);
  assert.deepEqual(splitSegmentText(exact).pieces, [exact]);
});

test("long paragraphs split at sentence ends, keep the speaker, and rejoin to the exact text", () => {
  const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about the roadmap, the budget and the launch plan.`);
  const paragraph = sentences.join(" ");
  const prepared = prepare(`Craig: ${paragraph}\nAditya: Short reply.\nCraig: ok`);
  const craig = prepared.segments.filter((segment) => payloadOf(segment).turn_index === 0);
  assert.ok(craig.length > 1);
  assert.ok(craig.every((segment) => segment.speaker === "Craig"));
  assert.ok(craig.every((segment) => segment.text.length <= MAX_SEGMENT_CHARS));
  assert.ok(craig.every((segment) => /\.$/.test(segment.text)), "pieces end at sentence boundaries");
  assert.equal(craig.map((segment) => segment.text).join(" "), paragraph);
  assert.deepEqual(craig.map((segment) => payloadOf(segment).fragment_index), craig.map((_, i) => i));
  assert.ok(craig.every((segment) => payloadOf(segment).fragment_count === craig.length));
  assert.ok(prepared.warnings.some((warning) => warning.code === "segments_split"));
  assert.equal(prepared.segments.at(-1)!.speaker, "Craig");
});

test("one enormous sentence splits at clauses, then words, then mid-token, and always terminates", () => {
  const clauses = Array.from({ length: 60 }, (_, i) => `clause ${i} with some words`).join(", ");
  const byClause = splitSegmentText(clauses);
  assert.ok(byClause.pieces.length > 1 && byClause.pieces.every((piece) => piece.length <= MAX_SEGMENT_CHARS));
  assert.equal(byClause.pieces.join(" "), clauses);
  assert.equal(byClause.hardSplit, false);

  const noPunctuation = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
  const byWord = splitSegmentText(noPunctuation);
  assert.equal(byWord.pieces.join(" "), noPunctuation);

  const url = `https://example.com/${"a".repeat(2000)}`;
  const byToken = splitSegmentText(`See ${url} now.`);
  assert.equal(byToken.hardSplit, true);
  assert.ok(byToken.pieces.every((piece) => piece.length <= MAX_SEGMENT_CHARS));
  assert.equal(byToken.pieces.join(""), `See${url}now.`.replace(/\s/g, ""));

  const emoji = "😀".repeat(1000);
  assert.ok(splitSegmentText(emoji, 7).pieces.every((piece) => Array.from(piece).every((char) => char === "😀")), "no split surrogate pairs");
});

// ------------------------------------------------------------------ ordering
test("source order is stable: segment_index is 0..n-1 and canonical ordering keeps it, however rows are shuffled", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `${i % 2 ? "Craig" : "Aditya"}: line ${i}`).join("\n");
  const prepared = prepare(lines);
  const indexes = prepared.segments.map((segment) => payloadOf(segment).segment_index);
  assert.deepEqual(indexes, indexes.map((_, i) => i));
  const withIds = prepared.segments.map((segment, i) => ({ ...segment, id: `id-${String((i * 7919) % 300).padStart(4, "0")}` }));
  const shuffled = [...withIds].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(canonicalTranscriptOrder(shuffled).map((segment) => segment.text), prepared.segments.map((segment) => segment.text));
  // Parsing the same text twice gives identical rows.
  assert.deepEqual(prepare(lines), prepared);
});

test("every row is compatible with the replace RPC: speaker, participant_name, text, null timestamp, raw_payload", () => {
  for (const segment of prepare(VTT, "vtt").segments) {
    assert.deepEqual(Object.keys(segment).sort(), ["participant_name", "raw_payload", "speaker", "text", "timestamp"]);
    assert.equal(segment.timestamp, null);
    assert.equal(segment.participant_name, null);
    assert.ok(segment.text.length > 0);
    const payload = payloadOf(segment);
    assert.match(payload.content_sha256, /^[0-9a-f]{64}$/);
    assert.equal(payload.parser_version, 1);
  }
});

test("the content hash depends on text, source and declared format", () => {
  const text = normalizeTranscriptText("Craig: hi\nAditya: hello");
  const hash = (source: "manual_paste" | "manual_upload", hint: "txt" | null, value = text) =>
    prepareTranscriptImport({ text: value, source, formatHint: hint }).contentSha256;
  assert.equal(hash("manual_paste", null), hash("manual_paste", null));
  assert.notEqual(hash("manual_paste", null), hash("manual_upload", null));
  assert.notEqual(hash("manual_paste", null), hash("manual_paste", "txt"));
  assert.notEqual(hash("manual_paste", null), hash("manual_paste", null, `${text} more`));
});

// ------------------------------------------------------------------ preview
test("preview diagnostics: format, counts, speakers, offsets, samples and the missing-date warning", () => {
  const prepared = prepareTranscriptImport({ text: normalizeTranscriptText(VTT), source: "manual_upload", formatHint: "vtt" });
  const preview = buildTranscriptImportPreview(prepared, { meetingDate: null });
  assert.equal(preview.format, "webvtt");
  assert.equal(preview.segmentCount, 3);
  assert.deepEqual(preview.speakers, [{ label: "Craig", segmentCount: 1 }, { label: "Aditya Rao", segmentCount: 1 }]);
  assert.equal(preview.hasSpeakers, true);
  assert.equal(preview.hasTimeOffsets, true);
  assert.equal(preview.hasAbsoluteTimestamps, false);
  assert.deepEqual(preview.sampleSegments.map((sample) => sample.speaker), ["Craig", "Aditya Rao", "Unknown Speaker"]);
  assert.ok(preview.warnings.some((warning) => warning.code === "meeting_date_missing"));
  assert.ok(!buildTranscriptImportPreview(prepared, { meetingDate: "2026-08-19" }).warnings.some((warning) => warning.code === "meeting_date_missing"));

  const many = prepare(Array.from({ length: 50 }, (_, i) => `${i % 2 ? "Craig" : "Aditya"}: line ${i}`).join("\n"));
  const sample = buildTranscriptImportPreview(many, { meetingDate: null }).sampleSegments.map((s) => s.index);
  assert.deepEqual(sample, [0, 1, 2, 3, 4, 5, 48, 49]);
});

test("uncertain speaker labels are reported when a name appears once among many labelled turns", () => {
  const text = ["Craig: a", "Aditya: b", "Craig: c", "Aditya: d", "Craig: e", "Aditya: f", "Remember: bring the docs", "Craig: g"].join("\n");
  const warning = prepare(text).warnings.find((w) => w.code === "uncertain_speaker_labels");
  assert.deepEqual(warning?.details, { labels: ["Remember"] });
  assert.equal(prepare("Craig: hi\nAditya: hello\nCraig: bye").warnings.some((w) => w.code === "uncertain_speaker_labels"), false);
});
