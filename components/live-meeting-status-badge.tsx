"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { MeetingStatusBadge } from "@/components/meeting-status-badge";
import type { Meeting } from "@/lib/types";

const ACTIVE_STATUSES: Meeting["status"][] = ["joining", "recording", "processing"];
const TERMINAL_SYNC_STATUSES: Meeting["status"][] = [
  "transcript_ready",
  "completed",
  "failed"
];

type MeetingStatusEventDetail = {
  meetingId: string;
  status: Meeting["status"];
};

export function LiveMeetingStatusBadge({
  meetingId,
  initialStatus
}: {
  meetingId: string;
  initialStatus: Meeting["status"];
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);

  const applyStatus = useCallback(
    (nextStatus: Meeting["status"]) => {
      setStatus(nextStatus);
      if (TERMINAL_SYNC_STATUSES.includes(nextStatus)) {
        router.refresh();
      }
    },
    [router]
  );

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    function handleStatusEvent(event: Event) {
      const detail = (event as CustomEvent<MeetingStatusEventDetail>).detail;
      if (detail?.meetingId === meetingId) {
        applyStatus(detail.status);
      }
    }

    window.addEventListener("parfait:meeting-status", handleStatusEvent);
    return () => window.removeEventListener("parfait:meeting-status", handleStatusEvent);
  }, [applyStatus, meetingId]);

  useEffect(() => {
    if (!ACTIVE_STATUSES.includes(status)) return;

    let cancelled = false;
    async function refreshStatus() {
      try {
        const response = await fetch(`/api/meetings/${meetingId}`, {
          method: "GET",
          cache: "no-store"
        });
        if (!response.ok || cancelled) return;

        const data = (await response.json()) as {
          meeting?: { status?: Meeting["status"] };
        };
        if (data.meeting?.status && !cancelled) {
          applyStatus(data.meeting.status);
        }
      } catch {
        // Keep the last known status and retry on the next interval.
      }
    }

    void refreshStatus();
    const interval = window.setInterval(refreshStatus, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [applyStatus, meetingId, status]);

  return <MeetingStatusBadge status={status} />;
}
