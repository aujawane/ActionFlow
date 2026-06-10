"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const googleMeetRegex = /^https:\/\/meet\.google\.com\/[a-z0-9-]+($|[/?].*)/i;

export function NewMeetingForm() {
  const router = useRouter();
  const [meetingUrl, setMeetingUrl] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    if (!googleMeetRegex.test(meetingUrl.trim())) {
      setLoading(false);
      setError("Please enter a valid Google Meet URL (https://meet.google.com/...).");
      return;
    }

    const response = await fetch("/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meetingUrl, title: title || undefined })
    });

    const data = await response.json();
    setLoading(false);

    if (!response.ok) {
      setError(data.error ?? "Failed to create meeting");
      return;
    }

    router.push(`/meetings/${data.meeting.id}`);
    router.refresh();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="max-w-2xl space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Meeting Setup</h2>
        <p className="text-xs text-slate-500">
          Paste a Google Meet URL to create a meeting record.
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium text-slate-700" htmlFor="title">
          Meeting title (optional)
        </label>
        <input
          id="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Q3 Product Planning"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
        />
      </div>

      <div className="space-y-1">
        <label
          className="text-sm font-medium text-slate-700"
          htmlFor="meeting-url"
        >
          Meeting URL
        </label>
        <input
          id="meeting-url"
          type="url"
          required
          value={meetingUrl}
          onChange={(event) => setMeetingUrl(event.target.value)}
          placeholder="https://meet.google.com/abc-defg-hij"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
        />
        <p className="text-xs text-slate-500">Only Google Meet links are supported right now.</p>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-70"
      >
        {loading ? "Creating..." : "Create Meeting"}
      </button>

      {error ? <p className="text-sm text-rose-700">{error}</p> : null}
    </form>
  );
}
