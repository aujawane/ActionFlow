import {
  buildMeetingSpeakerRoster,
  getRawSpeakerLabel
} from "@/lib/speaker-aliases";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  MeetingSpeakerAlias,
  MeetingSpeakerRosterItem,
  MeetingTask,
  TranscriptSegment
} from "@/lib/types";

export type SpeakerMappingInput = {
  rawSpeakerLabel: string;
  displayName: string;
};

export type MeetingSpeakerResolutionData = {
  speakers: MeetingSpeakerRosterItem[];
  aliases: MeetingSpeakerAlias[];
};

async function loadRows(meetingId: string) {
  const [
    { data: segments, error: segmentsError },
    { data: aliases, error: aliasesError },
    { data: tasks, error: tasksError }
  ] = await Promise.all([
    supabaseAdmin
      .from("transcript_segments")
      .select("*")
      .eq("meeting_id", meetingId)
      .order("timestamp", { ascending: true }),
    supabaseAdmin
      .from("meeting_speaker_aliases")
      .select("*")
      .eq("meeting_id", meetingId)
      .order("raw_speaker_label", { ascending: true }),
    supabaseAdmin
      .from("meeting_tasks")
      .select("*")
      .eq("meeting_id", meetingId)
      .order("created_at", { ascending: true })
  ]);

  const error = segmentsError ?? aliasesError ?? tasksError;
  if (error) throw new Error(error.message);

  return {
    segments: (segments ?? []) as TranscriptSegment[],
    aliases: (aliases ?? []) as MeetingSpeakerAlias[],
    tasks: (tasks ?? []) as MeetingTask[]
  };
}

export async function getMeetingSpeakerResolution(
  meetingId: string
): Promise<MeetingSpeakerResolutionData> {
  const { segments, aliases, tasks } = await loadRows(meetingId);
  return {
    speakers: buildMeetingSpeakerRoster({ segments, aliases, tasks }),
    aliases
  };
}

function normalizeMappings(mappings: SpeakerMappingInput[]) {
  const byRawLabel = new Map<string, SpeakerMappingInput>();
  for (const mapping of mappings) {
    const rawSpeakerLabel = mapping.rawSpeakerLabel.trim();
    const displayName = mapping.displayName.trim();
    if (!rawSpeakerLabel || !displayName) continue;
    byRawLabel.set(rawSpeakerLabel.toLowerCase(), {
      rawSpeakerLabel,
      displayName
    });
  }
  return Array.from(byRawLabel.values());
}

function equalsName(left: string | null | undefined, right: string) {
  return left?.trim().toLowerCase() === right.trim().toLowerCase();
}

export async function saveMeetingSpeakerMappings(
  meetingId: string,
  mappings: SpeakerMappingInput[]
) {
  const normalizedMappings = normalizeMappings(mappings);
  if (normalizedMappings.length === 0) {
    throw new Error("At least one valid speaker mapping is required.");
  }

  const before = await loadRows(meetingId);
  const previousAliases = new Map(
    before.aliases.map((alias) => [
      alias.raw_speaker_label.trim().toLowerCase(),
      alias.display_name.trim()
    ])
  );

  const { error: upsertError } = await supabaseAdmin
    .from("meeting_speaker_aliases")
    .upsert(
      normalizedMappings.map((mapping) => ({
        meeting_id: meetingId,
        raw_speaker_label: mapping.rawSpeakerLabel,
        display_name: mapping.displayName
      })),
      { onConflict: "meeting_id,raw_speaker_label" }
    );
  if (upsertError) throw new Error(upsertError.message);

  for (const mapping of normalizedMappings) {
    const previousDisplayName = previousAliases.get(
      mapping.rawSpeakerLabel.toLowerCase()
    );
    const matchingSegmentIds = before.segments
      .filter(
        (segment) =>
          equalsName(getRawSpeakerLabel(segment), mapping.rawSpeakerLabel) ||
          Boolean(
            previousDisplayName &&
              equalsName(segment.resolved_speaker, previousDisplayName)
          )
      )
      .map((segment) => segment.id);
    if (matchingSegmentIds.length > 0) {
      const { error: segmentUpdateError } = await supabaseAdmin
        .from("transcript_segments")
        .update({
          resolved_speaker: mapping.displayName,
          speaker: mapping.displayName
        })
        .in("id", matchingSegmentIds);
      if (segmentUpdateError) throw new Error(segmentUpdateError.message);
    }

    const matchingTaskIds = before.tasks
      .filter(
        (task) =>
          equalsName(task.owner, mapping.rawSpeakerLabel) ||
          Boolean(previousDisplayName && equalsName(task.owner, previousDisplayName))
      )
      .map((task) => task.id);
    if (matchingTaskIds.length > 0) {
      const { error: taskUpdateError } = await supabaseAdmin
        .from("meeting_tasks")
        .update({ owner: mapping.displayName })
        .in("id", matchingTaskIds);
      if (taskUpdateError) throw new Error(taskUpdateError.message);
    }
  }

  return getMeetingSpeakerResolution(meetingId);
}
