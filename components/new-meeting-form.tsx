"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  hasNewMeetingFormErrors,
  validateNewMeetingInput,
  type NewMeetingFormErrors
} from "@/lib/meeting-form-validation";

const NO_FIELD_ERRORS: NewMeetingFormErrors = { title: null, meetingUrl: null };

export function NewMeetingForm() {
  const router = useRouter();
  const [meetingUrl, setMeetingUrl] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<NewMeetingFormErrors>(NO_FIELD_ERRORS);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const errors = validateNewMeetingInput({ title, meetingUrl });
    setFieldErrors(errors);
    if (hasNewMeetingFormErrors(errors)) return;

    setLoading(true);
    const response = await fetch("/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meetingUrl: meetingUrl.trim(), title: title.trim() })
    });

    const data = await response.json().catch(() => ({}));
    setLoading(false);

    if (!response.ok) {
      setError(data.error ?? "Failed to create meeting");
      return;
    }

    router.push(`/meetings/${data.meeting.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="premium-card max-w-2xl space-y-5 p-6">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Add a Meeting</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Paste your meeting link and Parfait will join and capture the conversation.
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium text-slate-700" htmlFor="title">
          Meeting Title
        </label>
        <input
          id="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Weekly Product Sync"
          required
          className="premium-input"
        />
        {fieldErrors.title ? <p className="text-xs text-rose-600">{fieldErrors.title}</p> : null}
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium text-slate-700" htmlFor="meeting-url">
          Meeting Link
        </label>
        <input
          id="meeting-url"
          type="url"
          required
          value={meetingUrl}
          onChange={(event) => setMeetingUrl(event.target.value)}
          placeholder="https://zoom.us/j/... or https://meet.google.com/..."
          className="premium-input"
        />
        {fieldErrors.meetingUrl ? (
          <p className="text-xs text-rose-600">{fieldErrors.meetingUrl}</p>
        ) : null}
      </div>

      <button type="submit" disabled={loading} className="premium-button">
        {loading ? "Sending Parfait Bot..." : "Send Parfait Bot"}
      </button>

      {error ? <p className="text-sm text-rose-700">{error}</p> : null}
    </form>
  );
}
