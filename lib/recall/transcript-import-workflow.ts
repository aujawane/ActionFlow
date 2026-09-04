import { importRecallTranscriptStep } from "@/lib/recall/transcript-import-step";

/**
 * Durable orchestrator for importing a completed meeting's Recall transcript. Recall documents a
 * 15-second webhook response timeout and recommends acknowledging quickly with heavy work moved
 * out of the request -- the webhook route dispatches this workflow (via
 * lib/recall/enqueue-transcript-import.ts) instead of awaiting the fetch/download/import inline.
 * The Workflow SDK persists progress and resumes durably, exactly like
 * lib/meeting-analysis/workflow.ts's existing analysis orchestrator.
 */
export async function recallTranscriptImportWorkflow(input: {
  meetingId: string;
  recallBotId: string;
  requestOrigin?: string;
}) {
  "use workflow";

  await importRecallTranscriptStep(input);
}
