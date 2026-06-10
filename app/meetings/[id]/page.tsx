import { notFound } from "next/navigation";

import { InsightsPanel } from "@/components/insights-panel";
import { LiveTranscript } from "@/components/live-transcript";
import { MeetingActions } from "@/components/meeting-actions";
import { MeetingStatusBadge } from "@/components/meeting-status-badge";
import { PromptsPanel } from "@/components/prompts-panel";
import { requireUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export default async function MeetingDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const { data: meeting } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!meeting) notFound();

  const [{ data: segments }, { data: insights }, { data: prompts }] =
    await Promise.all([
      supabaseAdmin
        .from("transcript_segments")
        .select("*")
        .eq("meeting_id", id)
        .order("started_at", { ascending: true }),
      supabaseAdmin
        .from("extracted_insights")
        .select("*")
        .eq("meeting_id", id)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("generated_prompts")
        .select("*")
        .eq("meeting_id", id)
        .order("created_at", { ascending: true })
    ]);

  return (
    <section className="space-y-6">
      <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-slate-900">
            {meeting.title ?? "Untitled meeting"}
          </h1>
          <MeetingStatusBadge status={meeting.status} />
        </div>
        <p className="text-xs text-slate-500">{meeting.meeting_url}</p>
      </div>

      <MeetingActions meetingId={meeting.id} />

      <div className="grid gap-4 lg:grid-cols-2">
        <LiveTranscript meetingId={meeting.id} initialSegments={segments ?? []} />
        <InsightsPanel insights={insights ?? []} />
      </div>

      <PromptsPanel prompts={prompts ?? []} />
    </section>
  );
}
