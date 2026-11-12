import { z } from "zod";

/** Field helpers shared by the import API and the import form, so both apply identical rules. */

/** A calendar date, not in the future (one day of slack for time zones), and not before 1990. */
export const historicalMeetingDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Meeting date must be YYYY-MM-DD.")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Meeting date is not a real calendar date.")
  .refine((value) => value >= "1990-01-01", "Meeting date is too far in the past.")
  .refine(
    (value) => value <= new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    "Meeting date cannot be in the future."
  );

/** "Q3 planning (Aug 19).vtt" -> "Q3 planning (Aug 19)": the default title for an upload. */
export function titleFromFileName(fileName: string): string | null {
  const stem = fileName.replace(/^.*[\\/]/, "").replace(/\.[A-Za-z0-9]+$/, "");
  const title = stem.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200).trim();
  return title || null;
}
