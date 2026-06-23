import Link from "next/link";

import { MeetingCard } from "@/components/meeting-card";
import { requireUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getFirstName, getUserFullName } from "@/lib/user-profile";

function getTimeOfDayGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) {
    return "Good morning";
  }
  if (hour < 17) {
    return "Good afternoon";
  }
  return "Good evening";
}

export default async function DashboardPage() {
  const user = await requireUser();

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("full_name, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

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
  const fullName = getUserFullName(user, profile);
  const firstName = getFirstName(fullName);

  return (
    <section className="space-y-6">
      <div className="premium-card flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <p className="text-sm font-semibold text-brand-700">
            {getTimeOfDayGreeting()}, {firstName}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-600">
            Track your meetings and turn conversations into implementation prompts.
          </p>
          <p className="mt-1 text-xs text-slate-500">Logged in as {user.email}</p>
        </div>
        <Link
          href="/meetings/new"
          className="premium-button"
        >
          New Meeting
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="premium-card premium-card-hover p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Total meetings
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{totalMeetings}</p>
        </div>
        <div className="premium-card premium-card-hover p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Active
          </p>
          <p className="mt-2 text-2xl font-semibold text-amber-600">{activeMeetings}</p>
        </div>
        <div className="premium-card premium-card-hover p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Completed
          </p>
          <p className="mt-2 text-2xl font-semibold text-brand-700">{completedMeetings}</p>
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
        <div className="premium-empty">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-xl font-semibold text-white shadow-lg shadow-brand-700/20">
            +
          </div>
          <p className="mt-4 text-base font-semibold text-slate-900">No meetings yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
            Create your first meeting to start ingesting transcript events and generating prompts.
          </p>
          <Link
            href="/meetings/new"
            className="premium-button mt-5"
          >
            Create First Meeting
          </Link>
        </div>
      )}
    </section>
  );
}
