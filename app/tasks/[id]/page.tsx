import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";

import { MeetingStatusBadge } from "@/components/meeting-status-badge";
import { requireUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MeetingTask, MeetingTopic, TranscriptSegment } from "@/lib/types";

function formatLabel(value: string | null | undefined, fallback = "Unknown") {
  return (value || fallback)
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getSuggestedSteps(value: MeetingTask["suggested_steps"]) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.reduce<string[]>((steps, step) => {
    if (typeof step === "string" && step.trim().length > 0) {
      steps.push(step.trim());
    }
    return steps;
  }, []);
}

function getSegmentIds(value: MeetingTopic["segment_ids"]) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function formatTime(timestamp: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(timestamp));
}

export default async function TaskWorkspacePage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const { data: task } = await supabaseAdmin
    .from("meeting_tasks")
    .select("*")
    .eq("id", id)
    .single();

  if (!task) {
    notFound();
  }

  const typedTask = task as MeetingTask;

  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("id", typedTask.meeting_id)
    .eq("user_id", user.id)
    .single();

  if (!meeting) {
    notFound();
  }

  const { data: topic } = await supabaseAdmin
    .from("meeting_topics")
    .select("*")
    .eq("id", typedTask.topic_id)
    .eq("meeting_id", typedTask.meeting_id)
    .maybeSingle();

  const typedTopic = topic as MeetingTopic | null;
  const segmentIds = typedTopic ? getSegmentIds(typedTopic.segment_ids) : [];
  const { data: contextSegments } =
    segmentIds.length > 0
      ? await supabaseAdmin
          .from("transcript_segments")
          .select("*")
          .eq("meeting_id", typedTask.meeting_id)
          .in("id", segmentIds)
          .order("timestamp", { ascending: true })
      : await supabaseAdmin
          .from("transcript_segments")
          .select("*")
          .eq("meeting_id", typedTask.meeting_id)
          .order("timestamp", { ascending: true })
          .limit(8);

  const suggestedSteps = getSuggestedSteps(typedTask.suggested_steps);
  const segments = (contextSegments ?? []) as TranscriptSegment[];

  return (
    <section className="space-y-6">
      <div className="premium-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold text-brand-700">Task Workspace</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
              {typedTask.task}
            </h1>
            {typedTask.workspace_summary ? (
              <p className="mt-3 text-sm leading-6 text-slate-600">
                {typedTask.workspace_summary}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-brand-100 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-800">
              {formatLabel(typedTask.workspace_type, "other")}
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold capitalize text-slate-700">
              {formatLabel(typedTask.status, "pending")}
            </span>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          <section className="premium-card p-5">
            <h2 className="text-sm font-semibold text-slate-900">Task Summary</h2>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Owner
                </dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">
                  {typedTask.owner || "Unassigned"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Priority
                </dt>
                <dd className="mt-1 text-sm font-medium capitalize text-slate-900">
                  {typedTask.priority}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Task Type
                </dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">
                  {formatLabel(typedTask.task_type, "other")}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Confidence
                </dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">
                  {typedTask.confidence === null
                    ? "N/A"
                    : `${Math.round(typedTask.confidence * 100)}%`}
                </dd>
              </div>
            </dl>
          </section>

          <section className="premium-card p-5">
            <h2 className="text-sm font-semibold text-slate-900">Suggested Next Steps</h2>
            {suggestedSteps.length > 0 ? (
              <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-slate-700">
                {suggestedSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No suggested steps were generated.</p>
            )}
          </section>

          <section className="premium-card p-5">
            <h2 className="text-sm font-semibold text-slate-900">Source Quote</h2>
            {typedTask.source_quote ? (
              <blockquote className="mt-3 border-l-2 border-brand-200 pl-3 text-sm italic leading-6 text-slate-600">
                &ldquo;{typedTask.source_quote}&rdquo;
              </blockquote>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No source quote was captured.</p>
            )}
          </section>

          <section className="premium-card p-5">
            <h2 className="text-sm font-semibold text-slate-900">Meeting Context</h2>
            {segments.length > 0 ? (
              <div className="mt-4 max-h-[24rem] space-y-3 overflow-y-auto rounded-xl bg-slate-50 p-3">
                {segments.map((segment) => (
                  <div key={segment.id} className="rounded-xl bg-white p-3 shadow-sm">
                    <p className="text-xs font-semibold text-slate-500">
                      {segment.speaker || "Unknown speaker"} • {formatTime(segment.timestamp)}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-slate-700">{segment.text}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No transcript context is available.</p>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <section className="premium-card p-5">
            <h2 className="text-sm font-semibold text-slate-900">Related Meeting</h2>
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-slate-900">
                  {meeting.title || "Untitled meeting"}
                </p>
                <MeetingStatusBadge status={meeting.status} />
              </div>
              <p className="break-all text-xs text-slate-500">{meeting.meeting_url}</p>
              <Link href={`/meetings/${meeting.id}` as Route} className="secondary-button w-full">
                Open Meeting
              </Link>
            </div>
          </section>

          <section className="premium-card p-5">
            <h2 className="text-sm font-semibold text-slate-900">Topic Context</h2>
            {typedTopic ? (
              <div className="mt-4 space-y-3">
                <p className="text-sm font-semibold text-slate-900">{typedTopic.title}</p>
                {typedTopic.summary ? (
                  <p className="text-sm leading-6 text-slate-600">{typedTopic.summary}</p>
                ) : null}
                {typedTopic.separation_reason ? (
                  <p className="text-xs text-slate-500">
                    Why separated: {typedTopic.separation_reason}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No topic context is available.</p>
            )}
          </section>

          <section className="premium-card p-5">
            <h2 className="text-sm font-semibold text-slate-900">Help</h2>
            <div className="mt-4 space-y-3">
              <button
                type="button"
                disabled
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-400"
              >
                Guide Me coming in Sprint 3
              </button>
              <button
                type="button"
                disabled
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-400"
              >
                Do It For Me coming in Sprint 3
              </button>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
