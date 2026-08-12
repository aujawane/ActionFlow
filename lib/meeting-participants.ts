import { mergeProjectPeople, stringArray } from "@/lib/project-execution";
import { resolveTaskOwner } from "@/lib/speaker-aliases";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingSpeakerAlias } from "@/lib/types";

type OwnerBearingTask = { owner: string | null; owners?: unknown };
type OwnerBearingCommitment = {
  owner: string | null;
  lead_owner_name?: string | null;
  owners?: unknown;
};

/** Canonical "who is in this meeting" list for owner-assignment dropdowns.
 *
 * Precedence: confirmed speaker identity (meeting_speaker_aliases, added first so it wins ties
 * in mergeProjectPeople) -> extracted execution owner (task/commitment owner fields, resolved
 * through the same aliases). There is deliberately no middle "known meeting participant" tier:
 * audited for a lightweight, already-persisted source of that (a meeting_participants-style
 * table, an imported Recall attendee list, or any other per-meeting roster distinct from
 * transcript content) and none exists in this schema -- lib/recall/processing.ts only ever
 * derives participant names transiently for a console.info diagnostic; nothing is persisted.
 * The only place real attendee identity lives beyond aliases/extracted owners is
 * transcript_segments itself, which is out of bounds here by design (this must never become a
 * full-transcript fetch). Known limitation: a person who attended but was never given a speaker
 * alias and was never assigned any task/commitment will not appear in this list until one of
 * those happens.
 *
 * Reuses the same resolved-identity sources the rest of the product already trusts rather than a
 * new resolution system. Deduplicated with the same combined-label-aware helper Project People
 * already uses (mergeProjectPeople), so a raw "Craig Lauer and Laura Wetherhold" label collapses
 * away once both individuals are already present, instead of appearing as a third, obviously-
 * duplicate option. */
export function buildMeetingParticipantOptions(input: {
  aliases: MeetingSpeakerAlias[];
  tasks: OwnerBearingTask[];
  commitments: OwnerBearingCommitment[];
}): string[] {
  const names: string[] = [];

  function addResolved(raw: string | null | undefined) {
    const resolved = resolveTaskOwner(raw ?? null, input.aliases);
    if (resolved) names.push(resolved);
  }

  for (const alias of input.aliases) {
    const name = alias.display_name.trim();
    if (name) names.push(name);
  }

  for (const task of input.tasks) {
    addResolved(task.owner);
    for (const owner of stringArray(task.owners)) addResolved(owner);
  }

  for (const commitment of input.commitments) {
    addResolved(commitment.lead_owner_name ?? commitment.owner);
    for (const owner of stringArray(commitment.owners)) addResolved(owner);
  }

  return mergeProjectPeople(names);
}

/** Every task currently has a source meeting (meeting_tasks.meeting_id is required), so this is
 * the only data-loading path -- there is no project-level-task-without-a-meeting case to fall
 * back for today. Queries stay scoped to columns actually needed for name resolution, not full
 * rows. */
export async function loadMeetingParticipantOptions(meetingId: string): Promise<string[]> {
  const [{ data: aliases }, { data: tasks }, { data: commitments }] = await Promise.all([
    supabaseAdmin.from("meeting_speaker_aliases").select("*").eq("meeting_id", meetingId),
    supabaseAdmin.from("meeting_tasks").select("owner, owners").eq("meeting_id", meetingId),
    supabaseAdmin
      .from("meeting_commitments")
      .select("owner, lead_owner_name, owners")
      .eq("meeting_id", meetingId)
  ]);

  return buildMeetingParticipantOptions({
    aliases: (aliases ?? []) as MeetingSpeakerAlias[],
    tasks: (tasks ?? []) as OwnerBearingTask[],
    commitments: (commitments ?? []) as OwnerBearingCommitment[]
  });
}
