import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { enqueueRecallTranscriptImport } from "../lib/recall/enqueue-transcript-import";
import type { EnqueueTranscriptImportInput } from "../lib/recall/enqueue-transcript-import";

const INPUT = { meetingId: "meeting-1", recallBotId: "bot-1", requestOrigin: "https://parfait.example" };

// ---------------------------------------------------------------------------
// [required 1] a successful dispatch resolves once start() confirms enqueue.
// ---------------------------------------------------------------------------

test("enqueueRecallTranscriptImport resolves once the injected start() call resolves", async () => {
  let called: EnqueueTranscriptImportInput | null = null;
  await assert.doesNotReject(
    enqueueRecallTranscriptImport(INPUT, {
      startWorkflow: async (input) => {
        called = input;
      }
    })
  );
  assert.deepEqual(called, INPUT);
});

// ---------------------------------------------------------------------------
// [required 2 + 3] a start() failure propagates (rejects) instead of being swallowed --
// this is the exact behavior the webhook route's catch block depends on to return a non-2xx.
// ---------------------------------------------------------------------------

test("[required 2/3] a start() dispatch failure REJECTS -- it is not caught/logged-and-swallowed here", async () => {
  const dispatchError = new Error("Vercel Queues unreachable");

  await assert.rejects(
    enqueueRecallTranscriptImport(INPUT, {
      startWorkflow: async () => {
        throw dispatchError;
      }
    }),
    (error: unknown) => error === dispatchError
  );
});

test("[required 3] no after()/deferred-kickoff mechanism can intercept a dispatch failure -- the call is a single direct await", async () => {
  const source = await readFile(new URL("../lib/recall/enqueue-transcript-import.ts", import.meta.url), "utf8");
  // `after()` is discussed in comments explaining why it's deliberately NOT used here -- check
  // for the actual import/call, not the word "after(" anywhere (which the prose itself contains).
  assert.doesNotMatch(source, /import \{ after \} from "next\/server";/);
  assert.doesNotMatch(source, /after\(\(\)/);
  assert.doesNotMatch(source, /\btry\s*\{/);
  assert.match(source, /await startWorkflow\(input\);/);
});

// ---------------------------------------------------------------------------
// [required 1] start() is only awaited for enqueue confirmation, not workflow completion.
// ---------------------------------------------------------------------------

test("enqueueRecallTranscriptImport does not wait beyond what its startWorkflow promise resolves -- it never inspects/awaits a second, later completion signal", async () => {
  let resolvedDispatch = false;
  const startWorkflow = async () => {
    resolvedDispatch = true;
    // Deliberately resolves immediately -- simulates start() confirming enqueue without waiting
    // for the workflow to actually run.
  };

  await enqueueRecallTranscriptImport(INPUT, { startWorkflow });
  assert.equal(resolvedDispatch, true);
});

// ---------------------------------------------------------------------------
// Wiring: the real (non-injected) path calls the Workflow SDK's start() with this workflow.
// ---------------------------------------------------------------------------

test("the default dispatch path calls workflow/api's start() with recallTranscriptImportWorkflow", async () => {
  const source = await readFile(new URL("../lib/recall/enqueue-transcript-import.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ start \} from "workflow\/api";/);
  assert.match(
    source,
    /import \{ recallTranscriptImportWorkflow \} from "@\/lib\/recall\/transcript-import-workflow";/
  );
  assert.match(source, /start\(recallTranscriptImportWorkflow, \[input\]\)/);
});
