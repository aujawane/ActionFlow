export type MeetingPlatform = "google_meet" | "zoom" | "unknown";

const googleMeetRegex = /^https:\/\/meet\.google\.com\/[a-z0-9-]+($|[/?#].*)/i;
const zoomRegex = /^https:\/\/([a-z0-9-]+\.)*zoom\.us\/(?:j|s)\/[a-z0-9]+(?:[/?#].*)?$/i;

export function detectMeetingPlatform(meetingUrl: string): MeetingPlatform {
  const normalizedUrl = meetingUrl.trim();

  if (googleMeetRegex.test(normalizedUrl)) {
    return "google_meet";
  }

  if (zoomRegex.test(normalizedUrl)) {
    return "zoom";
  }

  return "unknown";
}

export function isSupportedMeetingUrl(meetingUrl: string) {
  return detectMeetingPlatform(meetingUrl) !== "unknown";
}

export function getSupportedMeetingUrlMessage() {
  return "Meeting URL must be a supported Google Meet or Zoom link.";
}
