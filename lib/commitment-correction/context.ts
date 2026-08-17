import { deriveSupportingPeople } from "@/lib/commitment-people";
import type { MeetingCommitment } from "@/lib/types";

type AcceptanceCriterion = { ref: string; title: string };

/** V4 stores acceptance criteria in commitment.metadata -- same small extraction duplicated
 * independently in commitments-panel.tsx and lib/meeting-assistant/context.ts (established
 * convention in this codebase: this one-off extraction is not worth sharing across UI/lib
 * layers). Included in the assistant's context read-only, for grounding -- acceptance criteria
 * are not an editable field in this pass (see schema.ts's allowlist comment). */
function acceptanceCriteria(commitment: MeetingCommitment): string[] {
  const metadata = commitment.metadata as { acceptance_criteria?: unknown } | null;
  const raw = metadata?.acceptance_criteria;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is AcceptanceCriterion =>
        Boolean(item) && typeof item === "object" && typeof (item as { title?: unknown }).title === "string"
    )
    .map((item) => item.title);
}

export type CommitmentCorrectionContext = {
  commitment: {
    id: string;
    title: string;
    description: string | null;
    owner: string | null;
    supporting_people: string[];
    due_date: string | null;
    priority: string;
    status: string;
    acceptance_criteria: string[];
  };
  source_meeting: { id: string; title: string | null } | null;
  today: string;
  participant_options: string[];
};

/** Compact, single-entity context for the correction agent -- deliberately far smaller than
 * Meeting Assistant's execution context (see lib/meeting-assistant/context.ts): this assistant
 * edits one already-open commitment, it does not answer questions about the whole meeting, so it
 * never loads tasks, topics, insights, or transcript. `today` grounds relative-date interpretation
 * ("next Friday", "by the end of next week") without needing any transcript/meeting-date context
 * -- see schema.ts and agent.ts for how due_date proposals are required to resolve to an absolute
 * YYYY-MM-DD before the user ever sees them. */
export function buildCommitmentCorrectionContext(input: {
  commitment: MeetingCommitment;
  sourceMeeting: { id: string; title: string | null } | null;
  participantOptions: string[];
}): CommitmentCorrectionContext {
  const currentOwner = input.commitment.lead_owner_name ?? input.commitment.owner ?? null;
  return {
    commitment: {
      id: input.commitment.id,
      title: input.commitment.title,
      description: input.commitment.description,
      owner: currentOwner,
      supporting_people: deriveSupportingPeople(input.commitment.owners, currentOwner),
      due_date: input.commitment.due_date,
      priority: input.commitment.priority,
      status: input.commitment.status,
      acceptance_criteria: acceptanceCriteria(input.commitment)
    },
    source_meeting: input.sourceMeeting,
    today: new Date().toISOString().slice(0, 10),
    participant_options: input.participantOptions
  };
}
