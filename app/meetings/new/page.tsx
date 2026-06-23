import { NewMeetingForm } from "@/components/new-meeting-form";
import { requireUser } from "@/lib/auth";

export default async function NewMeetingPage() {
  await requireUser();

  return (
    <section className="space-y-4">
      <div className="premium-card p-6">
        <p className="text-sm font-semibold text-brand-700">New Meeting</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
          Create new meeting
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Paste a Google Meet link to create and track a new meeting.
        </p>
      </div>
      <NewMeetingForm />
    </section>
  );
}
