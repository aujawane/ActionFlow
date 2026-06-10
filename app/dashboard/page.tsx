import Link from "next/link";

import { MeetingCard } from "@/components/meeting-card";
import { requireUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export default async function DashboardPage() {
  const user = await requireUser();

  const { data: meetings, error } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  const safeMeetings = meetings ?? [];
  const totalMeetings = safeMeetings.length;
  const activeMeetings = safeMeetings.filter(
    (meeting) => meeting.status === "joining" || meeting.status === "recording"
  ).length;
  const completedMeetings = safeMeetings.filter(
    (meeting) => meeting.status === "completed"
  ).length;
  const failedMeetings = safeMeetings.filter((meeting) => meeting.status === "failed").length;

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-600">
            Track your meetings and turn conversations into implementation prompts.
          </p>
          <p className="mt-1 text-xs text-slate-500">Logged in as {user.email}</p>
        </div>
        <Link
          href="/meetings/new"
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          New Meeting
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Total meetings
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{totalMeetings}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Active
          </p>
          <p className="mt-2 text-2xl font-semibold text-amber-600">{activeMeetings}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Completed
          </p>
          <p className="mt-2 text-2xl font-semibold text-emerald-600">{completedMeetings}</p>
        </div>
      </div>

      {failedMeetings > 0 ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {failedMeetings} meeting bot creation attempt
          {failedMeetings > 1 ? "s" : ""} failed. Open each meeting for details and retry.
        </div>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          Unable to load meetings right now. Please refresh and try again.
        </div>
      ) : safeMeetings.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {safeMeetings.map((meeting) => (
            <MeetingCard key={meeting.id} meeting={meeting} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-sm font-medium text-slate-700">No meetings yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Create your first meeting to start ingesting transcript events and generating prompts.
          </p>
          <Link
            href="/meetings/new"
            className="mt-4 inline-flex rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Create First Meeting
          </Link>
        </div>
      )}
    </section>
  );
}
