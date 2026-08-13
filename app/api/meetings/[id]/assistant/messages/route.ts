import { NextResponse } from "next/server";
import { z } from "zod";

import { requireApiUser } from "@/lib/api-auth";
import { runMeetingAssistantAgent } from "@/lib/meeting-assistant/agent";
import { buildMeetingAssistantExecutionContext } from "@/lib/meeting-assistant/context";
import {
  selectRelevantTranscriptSegments,
  shouldIncludeTranscriptEvidence
} from "@/lib/meeting-assistant/transcript-selection";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  ExtractedInsight,
  Meeting,
  MeetingCommitment,
  MeetingComment,
  MeetingSpeakerAlias,
  MeetingTask,
  MeetingTopic,
  Project,
  TaskArtifact,
  TaskDependency
} from "@/lib/types";

/** Meeting-level "Ask Parfait" -- Q&A and follow-up generation grounded in the canonical current
 * execution graph plus, when the message plausibly needs it, targeted transcript evidence (see
 * lib/meeting-assistant/*). Deliberately not built on Project Brain (project-wide structured
 * mutation) or the Task Chat patch-proposal system (this feature does not mutate Parfait data --
 * see responseType="declined_mutation" in the agent). */
export const runtime = "nodejs";
export const maxDuration = 60;

const messageSchema = z.string().trim().min(1).max(4000);

async function getOwnedMeeting(meetingId: string, userId: string) {
  const { data } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("id", meetingId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  return data as Meeting | null;
}

async function loadMeetingComments(meetingId: string) {
  const { data, error } = await supabaseAdmin
    .from("meeting_comments")
    .select("id, meeting_id, user_id, role, message, metadata, created_at")
    .eq("meeting_id", meetingId)
    .order("created_at", { ascending: true });
  return { comments: (data ?? []) as MeetingComment[], error };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;

  const meeting = await getOwnedMeeting(id, auth.user.id);
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
  }

  const { comments, error } = await loadMeetingComments(id);
  if (error) {
    return NextResponse.json(
      { error: "Failed to load the meeting conversation.", details: error.message },
      { status: 500 }
    );
  }
  return NextResponse.json(
    { comments },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;

  const meeting = await getOwnedMeeting(id, auth.user.id);
  if (!meeting) {
    return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as { message?: unknown } | null;
  const parsedMessage = messageSchema.safeParse(body?.message);
  if (!parsedMessage.success) {
    return NextResponse.json(
      { error: "Message is required and must be 4,000 characters or fewer." },
      { status: 400 }
    );
  }
  const userMessage = parsedMessage.data;

  const [
    { comments: previousComments, error: historyError },
    { data: commitments },
    { data: tasks },
    { data: aliases },
    { data: topics },
    { data: insights },
    { data: project },
    { count: transcriptSegmentCount }
  ] = await Promise.all([
    loadMeetingComments(id),
    supabaseAdmin.from("meeting_commitments").select("*").eq("meeting_id", id),
    supabaseAdmin.from("meeting_tasks").select("*").eq("meeting_id", id),
    supabaseAdmin.from("meeting_speaker_aliases").select("*").eq("meeting_id", id),
    supabaseAdmin.from("meeting_topics").select("*").eq("meeting_id", id),
    supabaseAdmin.from("extracted_insights").select("*").eq("meeting_id", id),
    meeting.project_id
      ? supabaseAdmin.from("projects").select("id, name").eq("id", meeting.project_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabaseAdmin
      .from("transcript_segments")
      .select("id", { count: "exact", head: true })
      .eq("meeting_id", id)
  ]);
  if (historyError) {
    return NextResponse.json(
      { error: "Failed to load the meeting conversation.", details: historyError.message },
      { status: 500 }
    );
  }

  const safeTasks = (tasks ?? []) as MeetingTask[];
  const taskIds = safeTasks.map((task) => task.id);
  const [{ data: dependencies }, { data: artifacts }] = await Promise.all([
    taskIds.length
      ? supabaseAdmin.from("task_dependencies").select("*").in("task_id", taskIds)
      : Promise.resolve({ data: [] }),
    taskIds.length
      ? supabaseAdmin.from("task_artifacts").select("*").in("task_id", taskIds)
      : Promise.resolve({ data: [] })
  ]);

  const { error: userInsertError } = await supabaseAdmin.from("meeting_comments").insert({
    meeting_id: id,
    user_id: auth.user.id,
    role: "user",
    message: userMessage,
    metadata: {}
  });
  if (userInsertError) {
    return NextResponse.json(
      { error: "Failed to save your message.", details: userInsertError.message },
      { status: 500 }
    );
  }

  const executionContext = buildMeetingAssistantExecutionContext({
    meeting,
    project: project as Pick<Project, "id" | "name"> | null,
    commitments: (commitments ?? []) as MeetingCommitment[],
    tasks: safeTasks,
    dependencies: (dependencies ?? []) as TaskDependency[],
    artifacts: (artifacts ?? []) as TaskArtifact[],
    aliases: (aliases ?? []) as MeetingSpeakerAlias[],
    topics: (topics ?? []) as MeetingTopic[],
    insights: (insights ?? []) as ExtractedInsight[]
  });

  const meetingAnalyzed = executionContext.commitments.length > 0 || executionContext.tasks.length > 0;
  const hasTranscript = (transcriptSegmentCount ?? 0) > 0;

  let transcriptSegments: Awaited<ReturnType<typeof selectRelevantTranscriptSegments>>["segments"] = [];
  if (hasTranscript && shouldIncludeTranscriptEvidence(userMessage)) {
    const transcriptResult = await selectRelevantTranscriptSegments({ meetingId: id, message: userMessage });
    if (transcriptResult.error) {
      console.warn("[meeting-assistant] Transcript retrieval failed", {
        meeting_id: id,
        error: transcriptResult.error.message
      });
    } else {
      transcriptSegments = transcriptResult.segments;
    }
  }

  const agent = await runMeetingAssistantAgent({
    executionContext,
    transcriptSegments,
    history: previousComments,
    latestUserMessage: userMessage,
    meetingAnalyzed,
    hasTranscript
  });

  let assistantMessage: string;
  let metadata: MeetingComment["metadata"] = {};
  if (agent.ok) {
    metadata = { responseType: agent.result.responseType };
    if (agent.result.generatedContent.length > 0) {
      metadata.generatedContent = agent.result.generatedContent;
    }
    if (agent.sources.length > 0) {
      metadata.sources = agent.sources;
    }
    assistantMessage = agent.result.assistantMessage;
  } else {
    console.error("[meeting-assistant] Agent failed", {
      meeting_id: id,
      error: agent.error,
      details: agent.details
    });
    assistantMessage = "I could not generate a response right now. Your message was saved -- please try again.";
  }

  const { error: assistantInsertError } = await supabaseAdmin.from("meeting_comments").insert({
    meeting_id: id,
    user_id: null,
    role: "assistant",
    message: assistantMessage,
    metadata
  });
  if (assistantInsertError) {
    console.error("[meeting-assistant] Failed to save assistant response", {
      meeting_id: id,
      error: assistantInsertError.message
    });
  }

  const { comments, error: reloadError } = await loadMeetingComments(id);
  if (reloadError) {
    return NextResponse.json(
      {
        error: "Message saved, but the updated conversation could not be loaded.",
        details: reloadError.message
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ comments }, { status: 201 });
}
