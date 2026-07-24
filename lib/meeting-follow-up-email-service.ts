import {
  generateIndividualFollowUpDrafts,
  generateTeamFollowUpDraft,
  groupTasksByAssignee,
  toFollowUpTasks
} from "@/lib/meeting-follow-up-emails";
import { isCommittedWork } from "@/lib/execution-display";
import { applySpeakerAliasesToTasks } from "@/lib/speaker-aliases";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { loadResolvedMeetingTranscriptSegments } from "@/lib/transcript-segments";
import type {
  ExtractedInsight,
  FollowUpEmailMode,
  JsonValue,
  Meeting,
  MeetingArtifact,
  MeetingTask,
  MeetingTopic
} from "@/lib/types";

const INDIVIDUAL_TYPE = "follow_up_email_individual";
const TEAM_TYPE = "follow_up_email_team_summary";

function metadataString(artifact: MeetingArtifact, key: string) {
  const value = artifact.metadata?.[key];
  return typeof value === "string" ? value : null;
}

function metadataStringArray(artifact: MeetingArtifact, key: string) {
  const value = artifact.metadata?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function artifactKey(artifact: MeetingArtifact) {
  if (artifact.artifact_type === TEAM_TYPE) return TEAM_TYPE;
  return `${INDIVIDUAL_TYPE}:${metadataString(artifact, "recipient_name")?.toLowerCase() ?? artifact.id}`;
}

export function latestFollowUpArtifacts(artifacts: MeetingArtifact[]) {
  const latest = new Map<string, MeetingArtifact>();
  for (const artifact of artifacts) {
    const key = artifactKey(artifact);
    const current = latest.get(key);
    if (
      !current ||
      artifact.version > current.version ||
      (artifact.version === current.version && artifact.created_at > current.created_at)
    ) {
      latest.set(key, artifact);
    }
  }

  return Array.from(latest.values()).sort((a, b) => {
    if (a.artifact_type !== b.artifact_type) {
      return a.artifact_type === INDIVIDUAL_TYPE ? -1 : 1;
    }
    return (metadataString(a, "recipient_name") ?? "").localeCompare(
      metadataString(b, "recipient_name") ?? ""
    );
  });
}

export async function loadMeetingFollowUpArtifacts(meetingId: string, userId: string) {
  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("id", meetingId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();

  if (!meeting) {
    return { ok: false as const, status: 404, error: "Meeting not found." };
  }

  const { data, error } = await supabaseAdmin
    .from("meeting_artifacts")
    .select("*")
    .eq("meeting_id", meetingId)
    .in("artifact_type", [INDIVIDUAL_TYPE, TEAM_TYPE])
    .neq("status", "failed")
    .order("version", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    return {
      ok: false as const,
      status: 500,
      error: "Failed to load follow-up emails.",
      details: error.message
    };
  }

  return {
    ok: true as const,
    artifacts: latestFollowUpArtifacts((data ?? []) as MeetingArtifact[])
  };
}

async function loadGenerationContext(meetingId: string, userId: string) {
  const { data: meeting, error: meetingError } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("id", meetingId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .single();

  if (meetingError || !meeting) {
    return {
      ok: false as const,
      status: 404,
      error: "Meeting not found.",
      details: meetingError?.message
    };
  }

  const [tasksResult, topicsResult, insightsResult, transcriptResult] =
    await Promise.all([
      supabaseAdmin
        .from("meeting_tasks")
        .select("*")
        .eq("meeting_id", meetingId)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("meeting_topics")
        .select("*")
        .eq("meeting_id", meetingId)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("extracted_insights")
        .select("*")
        .eq("meeting_id", meetingId)
        .order("created_at", { ascending: true }),
      loadResolvedMeetingTranscriptSegments({ meetingId, limit: 24 })
    ]);

  if (tasksResult.error) {
    return {
      ok: false as const,
      status: 500,
      error: "Failed to load meeting tasks.",
      details: tasksResult.error.message
    };
  }

  if (transcriptResult.segmentsError || transcriptResult.aliasesError) {
    return {
      ok: false as const,
      status: 500,
      error: "Failed to load meeting context.",
      details:
        transcriptResult.segmentsError?.message ?? transcriptResult.aliasesError?.message
    };
  }

  const tasks = applySpeakerAliasesToTasks(
    (tasksResult.data ?? []) as MeetingTask[],
    transcriptResult.aliases
  );
  const participantNames = new Map<string, string>();
  for (const name of [
    ...transcriptResult.segments.map((segment) => segment.speaker),
    ...tasks.map((task) => task.owner)
  ]) {
    const trimmed = name?.trim();
    if (!trimmed || trimmed.toLowerCase() === "unassigned") continue;
    participantNames.set(trimmed.toLowerCase(), trimmed);
  }

  const topics = (topicsResult.data ?? []) as MeetingTopic[];
  const insights = (insightsResult.data ?? []) as ExtractedInsight[];
  const summaryLines = [
    ...topics
      .filter((topic) => topic.summary?.trim())
      .map((topic) => `${topic.title}: ${topic.summary}`),
    ...insights
      .filter((insight) => insight.content?.trim())
      .slice(0, 8)
      .map((insight) => `${insight.category}: ${insight.content}`)
  ];
  const transcriptContext = transcriptResult.segments
    .map(
      (segment) =>
        `${segment.speaker?.trim() || "Unknown speaker"}: ${segment.text.trim().replace(/\s+/g, " ")}`
    )
    .join("\n");

  return {
    ok: true as const,
    meeting: meeting as Meeting,
    tasks,
    participants: Array.from(participantNames.values())
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, email: null })),
    meetingContext: [summaryLines.join("\n"), transcriptContext]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 16000)
  };
}

function versionFor(artifacts: MeetingArtifact[], type: string, recipientName?: string) {
  const matching = artifacts.filter(
    (artifact) =>
      artifact.artifact_type === type &&
      (!recipientName ||
        metadataString(artifact, "recipient_name")?.toLowerCase() ===
          recipientName.toLowerCase())
  );
  return Math.max(0, ...matching.map((artifact) => artifact.version)) + 1;
}

export async function generateMeetingFollowUpEmails(input: {
  meetingId: string;
  userId: string;
  mode: FollowUpEmailMode;
  regenerate?: boolean;
  recipientName?: string;
}) {
  const contextResult = await loadGenerationContext(input.meetingId, input.userId);
  if (!contextResult.ok) return contextResult;
  if (contextResult.tasks.filter(isCommittedWork).length === 0) {
    return {
      ok: false as const,
      status: 400,
      error: "No committed tasks found for this meeting yet."
    };
  }

  const { data: allArtifactRows, error: artifactError } = await supabaseAdmin
    .from("meeting_artifacts")
    .select("*")
    .eq("meeting_id", input.meetingId)
    .in("artifact_type", [INDIVIDUAL_TYPE, TEAM_TYPE]);
  if (artifactError) {
    return {
      ok: false as const,
      status: 500,
      error: "Failed to load existing follow-up emails.",
      details: artifactError.message
    };
  }

  const allArtifacts = (allArtifactRows ?? []) as MeetingArtifact[];
  const currentArtifacts = latestFollowUpArtifacts(
    allArtifacts.filter((artifact) => artifact.status !== "failed")
  );
  const followUpTasks = toFollowUpTasks(
    contextResult.tasks.filter(isCommittedWork)
  );
  if (followUpTasks.length === 0) {
    return {
      ok: false as const,
      status: 400,
      error: "No committed tasks found for follow-up emails."
    };
  }
  const generationContext = {
    meetingTitle: contextResult.meeting.title || "Untitled meeting",
    meetingDate: contextResult.meeting.created_at ?? null,
    participants: contextResult.participants,
    meetingContext: contextResult.meetingContext
  };

  if (input.mode === "team_summary") {
    const existing = currentArtifacts.find(
      (artifact) => artifact.artifact_type === TEAM_TYPE
    );
    if (
      existing &&
      !input.regenerate &&
      sameIds(
        metadataStringArray(existing, "included_task_ids"),
        followUpTasks.map((task) => task.id)
      )
    ) {
      return { ok: true as const, artifacts: [existing], reused: true };
    }

    const generated = await generateTeamFollowUpDraft({
      ...generationContext,
      tasks: followUpTasks
    });
    if (!generated.ok) {
      return { ...generated, status: 502 };
    }

    const { data: artifact, error } = await supabaseAdmin
      .from("meeting_artifacts")
      .insert({
        meeting_id: input.meetingId,
        artifact_type: TEAM_TYPE,
        title: generated.email.subject,
        content: generated.email.body,
        status: "generated",
        version: versionFor(allArtifacts, TEAM_TYPE),
        metadata: {
          mode: "team_summary",
          included_task_ids: generated.email.included_task_ids,
          included_participants: contextResult.participants.map(
            (participant) => participant.name
          )
        }
      })
      .select("*")
      .single();
    if (error || !artifact) {
      return {
        ok: false as const,
        status: 500,
        error: "Failed to save the team follow-up email.",
        details: error?.message
      };
    }
    return {
      ok: true as const,
      artifacts: [artifact as MeetingArtifact],
      reused: false
    };
  }

  const groups = groupTasksByAssignee(followUpTasks);
  if (groups.length === 0) {
    return {
      ok: false as const,
      status: 400,
      error:
        "Individual emails require assigned tasks. Use Team summary email instead or assign tasks first."
    };
  }

  let targetGroups = groups;
  if (input.recipientName) {
    targetGroups = groups.filter(
      (group) => group.assignee.toLowerCase() === input.recipientName!.toLowerCase()
    );
    if (targetGroups.length === 0) {
      return {
        ok: false as const,
        status: 400,
        error: "No assigned tasks were found for that recipient."
      };
    }
  }

  const existingByRecipient = new Map(
    currentArtifacts
      .filter((artifact) => artifact.artifact_type === INDIVIDUAL_TYPE)
      .map((artifact) => [
        metadataString(artifact, "recipient_name")?.toLowerCase(),
        artifact
      ])
  );
  if (!input.regenerate) {
    const matching = targetGroups
      .map((group) => {
        const artifact = existingByRecipient.get(group.assignee.toLowerCase());
        return artifact &&
          sameIds(
            metadataStringArray(artifact, "task_ids"),
            group.tasks.map((task) => task.id)
          )
          ? artifact
          : undefined;
      })
      .filter((artifact): artifact is MeetingArtifact => Boolean(artifact));
    if (matching.length === targetGroups.length) {
      return { ok: true as const, artifacts: matching, reused: true };
    }
    targetGroups = targetGroups.filter(
      (group) => {
        const artifact = existingByRecipient.get(group.assignee.toLowerCase());
        return !artifact ||
          !sameIds(
            metadataStringArray(artifact, "task_ids"),
            group.tasks.map((task) => task.id)
          );
      }
    );
  }

  const targetTaskIds = new Set(
    targetGroups.flatMap((group) => group.tasks.map((task) => task.id))
  );
  const generated = await generateIndividualFollowUpDrafts({
    ...generationContext,
    tasks: followUpTasks.filter((task) => targetTaskIds.has(task.id))
  });
  if (!generated.ok) return { ...generated, status: 502 };

  const rows = generated.emails.map((email) => ({
    meeting_id: input.meetingId,
    artifact_type: INDIVIDUAL_TYPE,
    title: email.subject,
    content: email.body,
    status: "generated",
    version: versionFor(allArtifacts, INDIVIDUAL_TYPE, email.recipient_name),
    metadata: {
      recipient_name: email.recipient_name,
      recipient_email: email.recipient_email,
      task_ids: email.task_ids,
      mode: "individual"
    } satisfies Record<string, JsonValue>
  }));
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("meeting_artifacts")
    .insert(rows)
    .select("*");
  if (insertError || !inserted) {
    return {
      ok: false as const,
      status: 500,
      error: "Failed to save individual follow-up emails.",
      details: insertError?.message
    };
  }

  const generatedArtifacts = inserted as MeetingArtifact[];
  if (!input.regenerate && !input.recipientName) {
    return {
      ok: true as const,
      artifacts: latestFollowUpArtifacts([
        ...generatedArtifacts,
        ...Array.from(existingByRecipient.values())
      ]),
      reused: false
    };
  }
  return { ok: true as const, artifacts: generatedArtifacts, reused: false };
}
