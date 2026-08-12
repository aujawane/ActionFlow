/** Human-readable, read-only date presentation (e.g. "Aug 13, 2026") for any stored ISO date
 * (YYYY-MM-DD) or timestamp. Never used for form inputs -- those keep native ISO values so the
 * browser's date picker and any downstream parsing stay untouched. */
export function formatReadableDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

/** Same convention as formatReadableDate, plus a time-of-day, for timestamps where same-day
 * ordering matters (e.g. an activity/change log where several events can land on one date). */
export function formatReadableDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}
