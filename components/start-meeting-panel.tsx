"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type StartMeetingPlatform = "zoom" | "google_meet";

type StartMeetingResponse = {
  meetingId?: string;
  meetingUrl?: string;
  platform?: string;
  error?: string;
  details?: string;
};

function platformLabel(platform: StartMeetingPlatform) {
  return platform === "zoom" ? "Zoom" : "Google Meet";
}

function platformButtonClass(platform: StartMeetingPlatform) {
  if (platform === "zoom") {
    return "rounded-xl bg-[#0B5CFF] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-700/20 transition hover:-translate-y-0.5 hover:bg-[#0A52E8] hover:shadow-blue-700/30 disabled:cursor-not-allowed disabled:opacity-60";
  }

  return "rounded-xl border border-yellow-300 bg-yellow-400 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-yellow-500/20 transition hover:-translate-y-0.5 hover:bg-yellow-300 hover:shadow-yellow-500/30 disabled:cursor-not-allowed disabled:opacity-60";
}

export function StartMeetingPanel() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [busyPlatform, setBusyPlatform] = useState<StartMeetingPlatform | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meetingUrlToOpen, setMeetingUrlToOpen] = useState<string | null>(null);

  async function startMeeting(platform: StartMeetingPlatform) {
    setBusyPlatform(platform);
    setError(null);
    setMeetingUrlToOpen(null);

    try {
      const response = await fetch("/api/meetings/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          title: title.trim() || undefined
        })
      });
      const data = (await response.json().catch(() => ({}))) as StartMeetingResponse;
      setBusyPlatform(null);

      if (!response.ok || !data.meetingUrl || !data.meetingId) {
        setError(
          data.details
            ? `${data.error ?? "Failed to start meeting"}: ${data.details}`
            : data.error ?? "Failed to start meeting"
        );
        return;
      }

      const openedWindow = window.open(data.meetingUrl, "_blank", "noopener,noreferrer");
      if (!openedWindow) {
        setMeetingUrlToOpen(data.meetingUrl);
      }

      router.push(`/meetings/${data.meetingId}`);
      router.refresh();
    } catch {
      setBusyPlatform(null);
      setError("Request failed. Check your connection and try again.");
    }
  }

  return (
    <div className="premium-card space-y-4 p-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Start Meeting</h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Create an instant meeting link, send the Parfait bot, and open the meeting.
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Meeting title (optional)
        </label>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Quick sync"
          className="premium-input"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {(["zoom", "google_meet"] as const).map((platform) => (
          <button
            type="button"
            key={platform}
            onClick={() => startMeeting(platform)}
            disabled={busyPlatform !== null}
            className={platformButtonClass(platform)}
          >
            {busyPlatform === platform
              ? `Starting ${platformLabel(platform)}...`
              : `Start ${platformLabel(platform)}`}
          </button>
        ))}
      </div>

      {error ? (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      {meetingUrlToOpen ? (
        <div className="rounded-xl border border-brand-100 bg-brand-50 px-3 py-2">
          <p className="text-sm text-brand-800">
            Your meeting was created, but the popup was blocked.
          </p>
          <a
            href={meetingUrlToOpen}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex rounded-xl bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-700"
          >
            Open Meeting
          </a>
        </div>
      ) : null}
    </div>
  );
}
