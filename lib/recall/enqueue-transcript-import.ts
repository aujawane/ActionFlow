import { start } from "workflow/api";

import { recallTranscriptImportWorkflow } from "@/lib/recall/transcript-import-workflow";

export type EnqueueTranscriptImportInput = {
  meetingId: string;
  recallBotId: string;
  requestOrigin?: string;
};

type StartWorkflow = (input: EnqueueTranscriptImportInput) => Promise<unknown>;

async function defaultStartWorkflow(input: EnqueueTranscriptImportInput) {
  await start(recallTranscriptImportWorkflow, [input]);
}

/**
 * Dispatches (enqueues) the durable transcript-import workflow and resolves once start() confirms
 * the run was accepted -- NOT once the workflow itself completes. start() only enqueues the run
 * through Vercel Queues; the actual transcript fetch/download/import happens later, in a
 * separately-scheduled workflow invocation (see transcript-import-workflow.ts/-step.ts), so this
 * call itself stays fast and well within Recall's webhook response window.
 *
 * Deliberately NOT wrapped in after(): the webhook route awaits this directly so that a dispatch
 * failure (e.g. Vercel Queues unreachable) propagates as a thrown error the route can turn into a
 * non-2xx response, letting Recall's own retry-on-non-2xx mechanism redeliver the event. Wrapping
 * this in after() would let the webhook return 2xx before knowing whether the dispatch even
 * succeeded, permanently forfeiting that retry -- the exact reliability gap this function exists
 * to close. (lib/meeting-analysis/enqueue.ts's after()+start() pattern is intentionally NOT
 * mirrored here for that reason; this call site's correctness depends on being awaited for real.)
 */
export async function enqueueRecallTranscriptImport(
  input: EnqueueTranscriptImportInput,
  options?: { startWorkflow?: StartWorkflow }
): Promise<void> {
  const startWorkflow = options?.startWorkflow ?? defaultStartWorkflow;
  await startWorkflow(input);
}
