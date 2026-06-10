import { NewMeetingForm } from "@/components/new-meeting-form";
import { requireUser } from "@/lib/auth";

export default async function NewMeetingPage() {
  await requireUser();

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Create new meeting</h1>
        <p className="mt-1 text-sm text-slate-600">
          Paste a Google Meet link to create and track a new meeting.
        </p>
      </div>
      <NewMeetingForm />
    </section>
  );
}
