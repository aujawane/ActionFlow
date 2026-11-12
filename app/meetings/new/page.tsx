import { AddMeetingModeNav } from "@/components/import-transcript-parts";
import { ImportTranscriptForm } from "@/components/import-transcript-form";
import { NewMeetingForm } from "@/components/new-meeting-form";
import { requireUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export default async function NewMeetingPage({
  searchParams
}: {
  searchParams: Promise<{ mode?: string | string[] }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const importing = params.mode === "import";

  // The project list is only a convenience for the picker. Ownership is enforced again by the
  // import API, so a tampered request can never assign someone else's project.
  const projects = importing
    ? ((
        await supabaseAdmin
          .from("projects")
          .select("id, name")
          .eq("owner_id", user.id)
          .order("updated_at", { ascending: false })
      ).data ?? [])
    : [];

  return (
    <section className="space-y-4">
      <div className="premium-card p-6">
        <p className="text-sm font-semibold text-brand-700">Add Meeting</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
          {importing ? "Import a Transcript" : "Add a Meeting"}
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          {importing
            ? "Bring in a transcript from a meeting that already happened and Parfait will analyze it like any other."
            : "Paste your meeting link and Parfait will join and capture the conversation."}
        </p>
      </div>
      <AddMeetingModeNav mode={importing ? "import" : "bot"} />
      {importing ? <ImportTranscriptForm projects={projects} /> : <NewMeetingForm />}
    </section>
  );
}
