import { processCompletedRecallMeeting } from "@/lib/recall/processing";

/**
 * Runs the actual Recall transcript fetch/download/import as a Workflow SDK step, reusing
 * processCompletedRecallMeeting -- the same logic sync-status's manual recovery path calls
 * synchronously. No transcript-processing business logic lives here; this is orchestration glue
 * only, split into its own "use step" function per this codebase's existing workflow/step
 * separation (see lib/meeting-analysis/workflow.ts + workflow-steps.ts).
 */
export async function importRecallTranscriptStep(input: {
  meetingId: string;
  recallBotId: string;
  requestOrigin?: string;
}) {
  "use step";

  console.info("[recall-transcript-import-workflow] step start", {
    meeting_id: input.meetingId,
    bot_id: input.recallBotId
  });

  const result = await processCompletedRecallMeeting(input);

  console.info("[recall-transcript-import-workflow] step complete", {
    meeting_id: input.meetingId,
    bot_id: input.recallBotId,
    status: result.status,
    inserted_segments: result.insertedCount,
    analysis_status: result.analysisStatus
  });

  return result;
}
