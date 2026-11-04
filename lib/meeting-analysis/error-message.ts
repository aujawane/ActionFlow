/** Workflow-safe: pure, no imports, no I/O. Imported by the "use workflow" function. */
export const V2_FALLBACK_ERROR_MESSAGE = "Meeting analysis failed.";

/**
 * The human-readable message of a thrown value, safe across JavaScript realms.
 *
 * A Workflow function runs in a `vm` context while the SDK builds step rejections in the host
 * realm, so `error instanceof Error` is false for exactly the errors that reach the workflow's
 * catch. This only reads properties:
 *   1. an object/function with a non-empty string `message` -> that message (trimmed)
 *   2. a non-empty string -> that string (trimmed)
 *   3. anything else -> the fallback
 * It never stringifies objects and never reads `stack`. It also never throws, because it runs on
 * the failure path where a throwing getter would otherwise leave the job unmarked.
 */
export function workflowErrorMessage(value: unknown, fallback: string = V2_FALLBACK_ERROR_MESSAGE): string {
  try {
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      const message = (value as { message?: unknown }).message;
      if (typeof message === "string" && message.trim().length > 0) return message.trim();
    } else if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  } catch {
    // Fall through to the fallback.
  }
  return fallback;
}
