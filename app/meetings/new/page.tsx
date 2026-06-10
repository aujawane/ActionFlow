import { NewMeetingForm } from "@/components/new-meeting-form";
import { requireUser } from "@/lib/auth";

export default async function NewMeetingPage() {
  await requireUser();

  return (
    <section className="space-y-3">
      <h1 className="text-2xl font-semibold text-slate-900">Create new meeting</h1>
      <p className="text-sm text-slate-600">
        Paste the conference link and ActionFlow will spin up a Recall.ai bot.
      </p>
      <NewMeetingForm />
    </section>
  );
}
