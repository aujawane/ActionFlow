import { z } from "zod";

import {
  meetingTitleSchema,
  supportedMeetingUrlSchema
} from "@/lib/meeting-form-validation";
import type { Meeting } from "@/lib/types";

export const meetingDetailsPatchSchema = z
  .object({
    title: meetingTitleSchema.optional(),
    meeting_url: supportedMeetingUrlSchema.optional()
  })
  .strict()
  .refine((value) => value.title !== undefined || value.meeting_url !== undefined, {
    message: "At least one editable meeting field is required."
  });

export const meetingProjectAssignmentSchema = z
  .object({
    project_id: z.string().uuid().nullable().optional(),
    new_project: z
      .object({
        name: z.string().trim().min(1).max(160),
        description: z.string().trim().max(2000).nullable().optional(),
        goal: z.string().trim().max(2000).nullable().optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .refine(
    (value) => !(value.project_id && value.new_project),
    "Choose an existing project or create a new one."
  );

export function canEditMeetingUrl(
  meeting: Pick<Meeting, "status" | "recall_bot_id">
): boolean {
  return meeting.status === "pending" && meeting.recall_bot_id === null;
}

export const MEETING_URL_LOCKED_MESSAGE =
  "Meeting link can’t be changed after Parfait has joined or started processing this meeting.";
