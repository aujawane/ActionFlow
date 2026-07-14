import { z } from "zod";

export const taskCommentMessageSchema = z.string().trim().min(1).max(4000);

export function parseTaskCommentMessage(value: unknown) {
  return taskCommentMessageSchema.safeParse(value);
}
