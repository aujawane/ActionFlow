/** Only a collision with the import UUID (meetings.id) is a safe duplicate retry.
 * Other unique violations must not be misclassified as an existing import. */
export function isMeetingPrimaryKeyViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === "23505" &&
    /violates unique constraint ["']meetings_pkey["']/.test(error.message ?? "");
}
