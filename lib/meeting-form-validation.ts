import { z } from "zod";

import {
  getSupportedMeetingUrlMessage,
  isSupportedMeetingUrl
} from "@/lib/meeting-platform";

export type NewMeetingFormErrors = {
  title: string | null;
  meetingUrl: string | null;
};

export const meetingTitleSchema = z
  .string()
  .trim()
  .min(1, "Meeting title is required.")
  .max(200, "Meeting title must be 200 characters or fewer.");

export const supportedMeetingUrlSchema = z
  .string()
  .trim()
  .url("Meeting link must be a valid URL.")
  .refine((value) => isSupportedMeetingUrl(value), {
    message: getSupportedMeetingUrlMessage()
  });

/**
 * Pure validation for the Add a Meeting form. The provider (Zoom vs. Google Meet) is always
 * auto-detected from the URL via lib/meeting-platform.ts -- there's no separate platform field
 * for the user to get wrong, so this only ever validates title and link.
 */
export function validateNewMeetingInput(input: {
  title: string;
  meetingUrl: string;
}): NewMeetingFormErrors {
  const title = meetingTitleSchema.safeParse(input.title);
  const meetingUrl = supportedMeetingUrlSchema.safeParse(input.meetingUrl);

  return {
    title: title.success ? null : title.error.issues[0]?.message ?? "Meeting title is required.",
    meetingUrl: meetingUrl.success
      ? null
      : input.meetingUrl.trim()
        ? meetingUrl.error.issues[0]?.message ?? getSupportedMeetingUrlMessage()
        : "Meeting link is required."
  };
}

export function hasNewMeetingFormErrors(errors: NewMeetingFormErrors): boolean {
  return Boolean(errors.title || errors.meetingUrl);
}
