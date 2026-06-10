import Link from "next/link";

import { MeetingCard } from "@/components/meeting-card";
import { requireUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export default async function DashboardPage() {
  const user = await requireUser();

  const { data: meetings } = await supabaseAdmin
    .from("meetings")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-600">
            Track your meetings and turn conversations into implementation prompts.
          </p>
        </div>
        <Link
          href="/meetings/new"
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          New Meeting
        </Link>
      </div>

      {meetings && meetings.length > 0 ? (
        <div className="grid gap-3">{meetings.map((m) => <MeetingCard key={m.id} meeting={m} />)}</div>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-600">
          No meetings yet. Create your first one to start ingesting transcripts.
        </div>
      )}
    </section>
  );
}
