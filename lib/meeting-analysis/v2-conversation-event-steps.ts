import { getStepMetadata } from "workflow";

import {
  finalizeV2ConversationEvents,
  planV2ConversationEvents,
  runV2ConversationEventUnit
} from "@/lib/meeting-analysis/v2-conversation-events";
import { asFatalOnValidation } from "@/lib/meeting-analysis/v2-workflow-steps";

/** Concrete B2.1 steps: serializable inputs, small acknowledgements, logic lives in
 * v2-conversation-events.ts. */
type V2JobInput = { meetingId: string; jobId: string; generation: number };

export async function planConversationEventsStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => planV2ConversationEvents(input, getStepMetadata().attempt));
}

export async function runConversationEventUnitStep(input: V2JobInput & { unitKey: string }) {
  "use step";
  return asFatalOnValidation(() => runV2ConversationEventUnit(input, getStepMetadata().attempt));
}

export async function finalizeConversationEventsStep(input: V2JobInput) {
  "use step";
  return asFatalOnValidation(() => finalizeV2ConversationEvents(input, getStepMetadata().attempt));
}
