import { mergeProjectPeople, stringArray } from "@/lib/project-execution";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getTranscriptSpeakerLabel } from "@/lib/transcript-speaker";

type ParticipantBearingSegment = {
  participant_name: string | null;
  speaker: string | null;
};
type OwnerBearingTask = { owner: string | null; owners?: unknown };
type OwnerBearingCommitment = {
  id?: string;
  owner: string | null;
  lead_owner_name?: string | null;
  owners?: unknown;
};
type NamedParticipant = { participant_name: string };

/** Launch participant choices come from Recall attribution and existing execution assignments. */
export function buildMeetingParticipantOptions(input: {
  transcriptSegments?: ParticipantBearingSegment[];
  tasks: OwnerBearingTask[];
  commitments: OwnerBearingCommitment[];
  commitmentParticipants?: NamedParticipant[];
}): string[] {
  const names: string[] = [];
  for (const segment of input.transcriptSegments ?? []) {
    const label = getTranscriptSpeakerLabel(segment);
    if (label !== "Unknown Speaker") names.push(label);
  }
  for (const task of input.tasks) {
    if (task.owner?.trim()) names.push(task.owner);
    names.push(...stringArray(task.owners));
  }
  for (const commitment of input.commitments) {
    const lead = commitment.lead_owner_name ?? commitment.owner;
    if (lead?.trim()) names.push(lead);
    names.push(...stringArray(commitment.owners));
  }
  for (const participant of input.commitmentParticipants ?? []) {
    if (participant.participant_name.trim()) names.push(participant.participant_name);
  }
  return mergeProjectPeople(names);
}

export async function loadMeetingParticipantOptions(meetingId: string): Promise<string[]> {
  const [{ data: segments }, { data: tasks }, { data: commitments }] = await Promise.all([
    supabaseAdmin
      .from("transcript_segments")
      .select("participant_name,speaker")
      .eq("meeting_id", meetingId),
    supabaseAdmin.from("meeting_tasks").select("owner,owners").eq("meeting_id", meetingId),
    supabaseAdmin
      .from("meeting_commitments")
      .select("id,owner,lead_owner_name,owners")
      .eq("meeting_id", meetingId)
  ]);
  const safeCommitments = (commitments ?? []) as OwnerBearingCommitment[];
  const commitmentIds = safeCommitments.flatMap((commitment) =>
    typeof commitment.id === "string" ? [commitment.id] : []
  );
  const { data: commitmentParticipants } = commitmentIds.length
    ? await supabaseAdmin
        .from("commitment_participants")
        .select("participant_name")
        .in("commitment_id", commitmentIds)
    : { data: [] };

  return buildMeetingParticipantOptions({
    transcriptSegments: (segments ?? []) as ParticipantBearingSegment[],
    tasks: (tasks ?? []) as OwnerBearingTask[],
    commitments: safeCommitments,
    commitmentParticipants: (commitmentParticipants ?? []) as NamedParticipant[]
  });
}
